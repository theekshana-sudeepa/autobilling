import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { isProd } from '../config/env.js';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    ok: false,
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` },
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong';
  let details: unknown;

  if (err instanceof AppError) {
    status = err.status;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002':
        status = 409;
        code = 'DUPLICATE';
        message = `A record with this ${(err.meta?.target as string[] | undefined)?.join(', ') ?? 'value'} already exists`;
        break;
      case 'P2003':
        status = 409;
        code = 'FK_CONSTRAINT';
        message = 'This record is referenced by other records';
        break;
      case 'P2025':
        status = 404;
        code = 'NOT_FOUND';
        message = 'Record not found';
        break;
      default:
        status = 400;
        code = `PRISMA_${err.code}`;
        message = 'Database request failed';
    }
  } else if (err instanceof Prisma.PrismaClientValidationError) {
    status = 400;
    code = 'PRISMA_VALIDATION';
    message = 'Invalid database query';
  }

  const log = { err, status, code, path: req.path, method: req.method, userId: req.user?.sub };
  if (status >= 500) logger.error(log, message);
  else logger.warn(log, message);

  res.status(status).json({
    ok: false,
    error: {
      code,
      message: status >= 500 && isProd ? 'Something went wrong' : message,
      ...(details ? { details } : {}),
      ...(isProd ? {} : { stack: err instanceof Error ? err.stack?.split('\n').slice(0, 5) : undefined }),
    },
    requestId: res.getHeader('x-request-id'),
  });
}
