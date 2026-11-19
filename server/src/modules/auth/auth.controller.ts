import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { ok } from '../../lib/http.js';
import { env, isProd } from '../../config/env.js';
import { Unauthorized, NotFound } from '../../lib/errors.js';
import * as authService from './auth.service.js';

const REFRESH_COOKIE = 'ab_rt';

function setRefreshCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    domain: env.COOKIE_DOMAIN,
    path: '/api/v1/auth',
    expires: expiresAt,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth', domain: env.COOKIE_DOMAIN });
}

const ctx = (req: Request) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as { email: string; password: string };
  const result = await authService.login(email, password, ctx(req));
  setRefreshCookie(res, result.refreshToken, result.refreshExpiresAt);
  ok(res, { accessToken: result.accessToken, user: result.user });
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const raw = (req.cookies?.[REFRESH_COOKIE] as string | undefined) ?? (req.body as { refreshToken?: string })?.refreshToken;
  if (!raw) throw Unauthorized('No refresh token supplied');

  try {
    const result = await authService.refresh(raw, ctx(req));
    setRefreshCookie(res, result.refreshToken, result.refreshExpiresAt);
    ok(res, { accessToken: result.accessToken, user: result.user });
  } catch (err) {
    clearRefreshCookie(res);
    throw err;
  }
}

export async function logout(req: Request, res: Response): Promise<void> {
  await authService.logout(req.cookies?.[REFRESH_COOKIE] as string | undefined);
  clearRefreshCookie(res);
  ok(res, { loggedOut: true });
}

export async function me(req: Request, res: Response): Promise<void> {
  const user = await prisma.user.findFirst({ where: { id: req.user!.sub, deletedAt: null } });
  if (!user) throw NotFound('User');
  ok(res, authService.toPublicUser(user));
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
  await authService.changePassword(req.user!.sub, currentPassword, newPassword);
  clearRefreshCookie(res);
  ok(res, { passwordChanged: true });
}

export async function listUsers(_req: Request, res: Response): Promise<void> {
  const users = await prisma.user.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  ok(res, users.map(authService.toPublicUser));
}

export async function createUser(req: Request, res: Response): Promise<void> {
  const user = await authService.createUser(req.body as never);
  ok(res, user, 201);
}

export async function updateUser(req: Request, res: Response): Promise<void> {
  const user = await prisma.user.update({ where: { id: req.params.id! }, data: req.body as never });
  ok(res, authService.toPublicUser(user));
}

export async function deleteUser(req: Request, res: Response): Promise<void> {
  const id = req.params.id!;
  await prisma.user.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
  await authService.logoutAll(id);
  ok(res, { deleted: true });
}
