import { Router, type Request, type Response } from 'express';
import { asyncHandler, ok, pageMeta, paginated } from '../../lib/http.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { audit } from '../../middleware/audit.js';
import * as svc from './client.service.js';
import { createClientSchema, idParamSchema, listClientsQuerySchema, updateClientSchema } from './client.schema.js';

export const clientRouter = Router();
clientRouter.use(requireAuth);

clientRouter.get(
  '/',
  validate({ query: listClientsQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as import('./client.schema.js').ListClientsQuery;
    const { items, total } = await svc.listClients(q);
    paginated(res, items, pageMeta(q.page, q.pageSize, total));
  }),
);

clientRouter.get(
  '/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => ok(res, await svc.getClient(req.params.id!))),
);

clientRouter.post(
  '/',
  validate({ body: createClientSchema }),
  asyncHandler(async (req, res) => {
    const client = await svc.createClient(req.body);
    await audit({ action: 'client.created', entity: 'Client', entityId: client.id, after: client, req });
    ok(res, client, 201);
  }),
);

clientRouter.patch(
  '/:id',
  validate({ params: idParamSchema, body: updateClientSchema }),
  asyncHandler(async (req, res) => {
    const { before, after } = await svc.updateClient(req.params.id!, req.body);
    await audit({ action: 'client.updated', entity: 'Client', entityId: after.id, before, after, req });
    ok(res, after);
  }),
);

clientRouter.delete(
  '/:id',
  requireRole('ADMIN'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const before = await svc.deleteClient(req.params.id!);
    await audit({ action: 'client.deleted', entity: 'Client', entityId: req.params.id!, before, req });
    ok(res, { deleted: true });
  }),
);
