import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

const json = {
  ok: false,
  error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
};

/** Global envelope — generous, protects against runaway clients. */
export const globalLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: json,
});

/** Credential stuffing defence: 8 attempts / 15 min / (ip + email). */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${req.ip ?? 'unknown'}:${String((req.body as { email?: string })?.email ?? '')}`,
  message: json,
});

/** Anything that sends an email or renders a PDF costs money / CPU. */
export const expensiveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: json,
});
