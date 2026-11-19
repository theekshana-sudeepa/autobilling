import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/http.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { authLimiter } from '../../middleware/rateLimit.js';
import * as c from './auth.controller.js';
import { changePasswordSchema, createUserSchema, loginSchema, refreshSchema, updateUserSchema } from './auth.schema.js';

const idParam = z.object({ id: z.string().cuid() });

export const authRouter = Router();

authRouter.post('/login', authLimiter, validate({ body: loginSchema }), asyncHandler(c.login));
authRouter.post('/refresh', validate({ body: refreshSchema }), asyncHandler(c.refresh));
authRouter.post('/logout', asyncHandler(c.logout));
authRouter.get('/me', requireAuth, asyncHandler(c.me));
authRouter.post('/change-password', requireAuth, validate({ body: changePasswordSchema }), asyncHandler(c.changePassword));

// User administration — ADMIN only.
authRouter.get('/users', requireAuth, requireRole('ADMIN'), asyncHandler(c.listUsers));
authRouter.post('/users', requireAuth, requireRole('ADMIN'), validate({ body: createUserSchema }), asyncHandler(c.createUser));
authRouter.patch(
  '/users/:id',
  requireAuth,
  requireRole('ADMIN'),
  validate({ params: idParam, body: updateUserSchema }),
  asyncHandler(c.updateUser),
);
authRouter.delete('/users/:id', requireAuth, requireRole('ADMIN'), validate({ params: idParam }), asyncHandler(c.deleteUser));
