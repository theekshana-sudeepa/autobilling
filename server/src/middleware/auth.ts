import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { UserRole } from '@prisma/client';
import { env } from '../config/env.js';
import { Forbidden, Unauthorized } from '../lib/errors.js';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: UserRole;
  tv: number; // tokenVersion
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
    }
  }
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL,
    issuer: 'autobilling',
    audience: 'autobilling-web',
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, {
    issuer: 'autobilling',
    audience: 'autobilling-web',
  }) as AccessTokenPayload;
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(Unauthorized());
  try {
    req.user = verifyAccessToken(header.slice(7));
    next();
  } catch (err) {
    const expired = err instanceof jwt.TokenExpiredError;
    next(expired ? Unauthorized('Access token expired') : Unauthorized('Invalid access token'));
  }
}

/** requireRole('ADMIN') — STAFF may read/operate, ADMIN may destroy & configure. */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(Unauthorized());
    if (!roles.includes(req.user.role)) return next(Forbidden(`Requires role: ${roles.join(' or ')}`));
    next();
  };
}
