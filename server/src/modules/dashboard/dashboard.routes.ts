import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ok } from '../../lib/http.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import * as svc from './dashboard.service.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

dashboardRouter.get('/overview', asyncHandler(async (_req, res) => ok(res, await svc.getOverview())));

dashboardRouter.get(
  '/revenue',
  validate({ query: z.object({ months: z.coerce.number().int().min(3).max(36).default(12) }) }),
  asyncHandler(async (req, res) => ok(res, await svc.getRevenueSeries(Number(req.query.months)))),
);

dashboardRouter.get(
  '/top-clients',
  validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(8) }) }),
  asyncHandler(async (req, res) => ok(res, await svc.getTopClients(Number(req.query.limit)))),
);

dashboardRouter.get('/ageing', asyncHandler(async (_req, res) => ok(res, await svc.getAgeingBuckets())));
dashboardRouter.get('/activity', asyncHandler(async (_req, res) => ok(res, await svc.getRecentActivity())));
dashboardRouter.get('/upcoming', asyncHandler(async (_req, res) => ok(res, await svc.getUpcomingBilling())));

/** One round-trip for the whole dashboard — the page renders from a single query. */
dashboardRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const [overview, revenue, topClients, ageing, activity, upcoming] = await Promise.all([
      svc.getOverview(),
      svc.getRevenueSeries(12),
      svc.getTopClients(6),
      svc.getAgeingBuckets(),
      svc.getRecentActivity(8),
      svc.getUpcomingBilling(6),
    ]);
    ok(res, { overview, revenue, topClients, ageing, activity, upcoming });
  }),
);
