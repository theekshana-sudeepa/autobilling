import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { corsOrigins, env, isProd } from './config/env.js';
import { logger } from './lib/logger.js';
import { globalLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { requireAuth } from './middleware/auth.js';
import { asyncHandler, ok } from './lib/http.js';
import { prisma } from './lib/prisma.js';

import { authRouter } from './modules/auth/auth.routes.js';
import { clientRouter } from './modules/clients/client.routes.js';
import { subscriptionRouter } from './modules/subscriptions/subscription.routes.js';
import { invoiceRouter } from './modules/invoices/invoice.routes.js';
import { paymentRouter } from './modules/payments/payment.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { emailLogRouter } from './modules/emaillogs/emaillog.routes.js';
import { settingsRouter } from './modules/settings/settings.routes.js';

export function createApp(): Express {
  const app = express();

  // Behind Nginx / a load balancer: trust exactly one proxy hop so req.ip is
  // the real client and the rate limiter cannot be spoofed by a header.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const id = (req.headers['x-request-id'] as string) ?? crypto.randomUUID();
    res.setHeader('x-request-id', id);
    next();
  });

  app.use(
    pinoHttp({
      logger,
      genReqId: (_req: IncomingMessage, res: ServerResponse) => res.getHeader('x-request-id') as string,
      autoLogging: {
        ignore: (req: IncomingMessage) => req.url === '/health' || req.url === '/api/v1/health',
      },
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: isProd ? [] : null,
        },
      },
      crossOriginResourcePolicy: { policy: 'cross-origin' }, // PDFs fetched by the SPA
      hsts: isProd ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  app.use(
    cors({
      origin(origin, cb) {
        // Server-to-server calls (cron, health checks) have no Origin header.
        if (!origin || corsOrigins.includes(origin)) return cb(null, true);
        logger.warn({ origin }, 'CORS origin rejected');
        cb(new Error('Not allowed by CORS'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      maxAge: 86_400,
    }),
  );

  app.use(compression());
  app.use(express.json({ limit: '4mb' })); // base64 logo upload headroom
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());
  app.use(globalLimiter);

  // Signed-in users only — invoice PDFs are not public documents.
  app.use('/storage', requireAuth, express.static(path.resolve(env.STORAGE_DIR), { maxAge: '1h', index: false, dotfiles: 'deny' }));

  app.get(
    '/health',
    asyncHandler(async (_req, res) => {
      const started = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      ok(res, {
        status: 'healthy',
        env: env.NODE_ENV,
        dbLatencyMs: Date.now() - started,
        uptimeSec: Math.round(process.uptime()),
        version: process.env.npm_package_version ?? '1.0.0',
      });
    }),
  );

  const v1 = express.Router();
  v1.use('/auth', authRouter);
  v1.use('/clients', clientRouter);
  v1.use('/subscriptions', subscriptionRouter);
  v1.use('/invoices', invoiceRouter);
  v1.use('/payments', paymentRouter);
  v1.use('/dashboard', dashboardRouter);
  v1.use('/email-logs', emailLogRouter);
  v1.use('/settings', settingsRouter);
  app.use('/api/v1', v1);

  /**
   * Single-process mode. With WEB_DIST set, this API also serves the built
   * admin UI, so there is nothing to configure in front of it — which is the
   * only way to run on cPanel/Passenger shared hosting.
   *
   * Registered AFTER the API so a bad /api path still 404s as JSON instead of
   * being answered with index.html, which would turn every typo into a
   * confusing "unexpected token <" in the browser.
   */
  if (env.WEB_DIST) {
    const dist = path.resolve(env.WEB_DIST);
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/storage/') || req.path === '/health') {
        return next();
      }
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
