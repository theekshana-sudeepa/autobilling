import { createRequire } from 'node:module';
import pino from 'pino';
import { env, isProd } from '../config/env.js';

/**
 * pino-pretty runs in a worker thread and is a devDependency, so it is absent
 * in production by design. Pino resolves the transport lazily and *throws at
 * construction* when it cannot find it — meaning one missing dev package takes
 * the whole API down at boot rather than degrading. Readable logs are never
 * worth an outage: check it resolves, fall back to JSON if it doesn't.
 */
function prettyAvailable(): boolean {
  if (isProd || env.NODE_ENV === 'test') return false;
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn('pino-pretty not installed — logging JSON. `npm i -D pino-pretty` for readable dev logs.');
    return false;
  }
}

export const logger = pino({
  level: env.LOG_LEVEL,
  transport: prettyAvailable()
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
    : undefined,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.currentPassword',
      'req.body.newPassword',
      'req.body.refreshToken',
      'res.headers["set-cookie"]',
      '*.smtpPassword',
      '*.passwordHash',
    ],
    censor: '[redacted]',
  },
  base: { service: 'autobilling-api' },
});
