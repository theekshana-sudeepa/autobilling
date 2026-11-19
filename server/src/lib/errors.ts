export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = status < 500;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const BadRequest = (msg = 'Bad request', details?: unknown) => new AppError(400, 'BAD_REQUEST', msg, details);
export const Unauthorized = (msg = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', msg);
export const Forbidden = (msg = 'You do not have access to this resource') => new AppError(403, 'FORBIDDEN', msg);
export const NotFound = (entity = 'Resource') => new AppError(404, 'NOT_FOUND', `${entity} not found`);
export const Conflict = (msg = 'Conflicting state', details?: unknown) => new AppError(409, 'CONFLICT', msg, details);
export const Unprocessable = (msg: string, details?: unknown) => new AppError(422, 'UNPROCESSABLE', msg, details);
export const TooManyRequests = (msg = 'Too many requests') => new AppError(429, 'RATE_LIMITED', msg);
export const Internal = (msg = 'Something went wrong') => new AppError(500, 'INTERNAL_ERROR', msg);
