import crypto from 'node:crypto';
import { addDays } from 'date-fns';
import type { User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../../lib/crypto.js';
import { signAccessToken } from '../../middleware/auth.js';
import { env } from '../../config/env.js';
import { Unauthorized, Conflict, NotFound, BadRequest } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../middleware/audit.js';

export interface SessionContext {
  ip?: string;
  userAgent?: string;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: PublicUser;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: User['role'];
  isActive: boolean;
  lastLoginAt: Date | null;
}

export const toPublicUser = (u: User): PublicUser => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  isActive: u.isActive,
  lastLoginAt: u.lastLoginAt,
});

async function issueSession(user: User, ctx: SessionContext, familyId?: string): Promise<AuthResult> {
  const raw = randomToken();
  const expiresAt = addDays(new Date(), env.REFRESH_TOKEN_TTL_DAYS);

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256(raw),
      familyId: familyId ?? crypto.randomUUID(),
      expiresAt,
      ip: ctx.ip?.slice(0, 60) ?? null,
      userAgent: ctx.userAgent?.slice(0, 250) ?? null,
    },
  });

  return {
    accessToken: signAccessToken({ sub: user.id, email: user.email, role: user.role, tv: user.tokenVersion }),
    refreshToken: raw,
    refreshExpiresAt: expiresAt,
    user: toPublicUser(user),
  };
}

export async function login(email: string, password: string, ctx: SessionContext): Promise<AuthResult> {
  const user = await prisma.user.findFirst({ where: { email, deletedAt: null } });

  // Constant-ish work whether or not the user exists — no user enumeration
  // via response timing.
  const hash = user?.passwordHash ?? '$2a$12$0000000000000000000000000000000000000000000000000000';
  const valid = await verifyPassword(password, hash);

  if (!user || !valid) throw Unauthorized('Invalid email or password');
  if (!user.isActive) throw Unauthorized('This account has been disabled');

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit({ action: 'auth.login', entity: 'User', entityId: user.id, actorId: user.id });

  return issueSession(user, ctx);
}

/**
 * Rotating refresh tokens with reuse detection.
 *
 * Each refresh consumes the presented token and issues a new one in the same
 * family. If a *already-revoked* token is presented, we assume theft and kill
 * the entire family — the attacker and the victim are both logged out.
 */
export async function refresh(rawToken: string, ctx: SessionContext): Promise<AuthResult> {
  const tokenHash = sha256(rawToken);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } });

  if (!stored) throw Unauthorized('Invalid refresh token');

  if (stored.revokedAt) {
    logger.warn({ userId: stored.userId, familyId: stored.familyId }, 'refresh token reuse detected — revoking family');
    await prisma.refreshToken.updateMany({
      where: { familyId: stored.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await audit({ action: 'auth.token_reuse_detected', entity: 'User', entityId: stored.userId, actorType: 'SYSTEM' });
    throw Unauthorized('Session invalidated, please sign in again');
  }

  if (stored.expiresAt < new Date()) throw Unauthorized('Refresh token expired');
  if (!stored.user.isActive || stored.user.deletedAt) throw Unauthorized('Account is no longer active');

  const next = await issueSession(stored.user, ctx, stored.familyId);
  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date(), replacedBy: sha256(next.refreshToken) },
  });

  return next;
}

export async function logout(rawToken: string | undefined): Promise<void> {
  if (!rawToken) return;
  await prisma.refreshToken.updateMany({
    where: { tokenHash: sha256(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Global sign-out: bump tokenVersion and revoke everything. */
export async function logoutAll(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } }),
    prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
}

export async function changePassword(userId: string, current: string, next: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw NotFound('User');
  if (!(await verifyPassword(current, user.passwordHash))) throw BadRequest('Current password is incorrect');
  if (await verifyPassword(next, user.passwordHash)) throw BadRequest('New password must differ from the current one');

  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(next) } });
  await logoutAll(userId);
  await audit({ action: 'auth.password_changed', entity: 'User', entityId: userId, actorId: userId });
}

export async function createUser(input: {
  email: string;
  name: string;
  password: string;
  role: User['role'];
}): Promise<PublicUser> {
  const exists = await prisma.user.findFirst({ where: { email: input.email } });
  if (exists) throw Conflict('A user with that email already exists');

  const user = await prisma.user.create({
    data: {
      email: input.email,
      name: input.name,
      role: input.role,
      passwordHash: await hashPassword(input.password),
    },
  });
  return toPublicUser(user);
}

/** Housekeeping — called by the nightly maintenance job. */
export async function pruneExpiredTokens(): Promise<number> {
  const { count } = await prisma.refreshToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: addDays(new Date(), -7) } }] },
  });
  return count;
}
