import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Wrap async handlers so rejections reach the error middleware. */
export const asyncHandler =
  <T>(fn: (req: Request, res: Response, next: NextFunction) => Promise<T>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export const ok = <T>(res: Response, data: T, status = 200): void => {
  res.status(status).json({ ok: true, data });
};

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export const paginated = <T>(res: Response, items: T[], meta: PageMeta): void => {
  res.status(200).json({ ok: true, data: items, meta });
};

export const pageMeta = (page: number, pageSize: number, total: number): PageMeta => ({
  page,
  pageSize,
  total,
  totalPages: Math.max(1, Math.ceil(total / pageSize)),
});
