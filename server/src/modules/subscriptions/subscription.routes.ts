import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ok, pageMeta, paginated } from '../../lib/http.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { audit } from '../../middleware/audit.js';
import * as svc from './subscription.service.js';
import {
  createSubscriptionSchema,
  idParamSchema,
  listSubscriptionsQuerySchema,
  updateSubscriptionSchema,
} from './subscription.schema.js';

export const subscriptionRouter = Router();
subscriptionRouter.use(requireAuth);

subscriptionRouter.get(
  '/',
  validate({ query: listSubscriptionsQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as import('./subscription.schema.js').ListSubscriptionsQuery;
    const { items, total } = await svc.listSubscriptions(q);
    paginated(res, items, pageMeta(q.page, q.pageSize, total));
  }),
);

subscriptionRouter.get(
  '/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => ok(res, await svc.getSubscription(req.params.id!))),
);

subscriptionRouter.post(
  '/',
  validate({ body: createSubscriptionSchema }),
  asyncHandler(async (req, res) => {
    const sub = await svc.createSubscription(req.body);
    await audit({ action: 'subscription.created', entity: 'Subscription', entityId: sub.id, after: sub, req });
    ok(res, sub, 201);
  }),
);

subscriptionRouter.patch(
  '/:id',
  validate({ params: idParamSchema, body: updateSubscriptionSchema }),
  asyncHandler(async (req, res) => {
    const { before, after } = await svc.updateSubscription(req.params.id!, req.body);
    await audit({ action: 'subscription.updated', entity: 'Subscription', entityId: after.id, before, after, req });
    ok(res, after);
  }),
);

subscriptionRouter.post(
  '/:id/pause',
  validate({ params: idParamSchema, body: z.object({ paused: z.boolean() }) }),
  asyncHandler(async (req, res) => {
    const sub = await svc.pauseSubscription(req.params.id!, req.body.paused);
    await audit({ action: `subscription.${req.body.paused ? 'paused' : 'resumed'}`, entity: 'Subscription', entityId: sub.id, req });
    ok(res, sub);
  }),
);

subscriptionRouter.post(
  '/:id/cancel',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const sub = await svc.cancelSubscription(req.params.id!);
    await audit({ action: 'subscription.cancelled', entity: 'Subscription', entityId: sub.id, req });
    ok(res, sub);
  }),
);

subscriptionRouter.delete(
  '/:id',
  requireRole('ADMIN'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const before = await svc.deleteSubscription(req.params.id!);
    await audit({ action: 'subscription.deleted', entity: 'Subscription', entityId: req.params.id!, before, req });
    ok(res, { deleted: true });
  }),
);
