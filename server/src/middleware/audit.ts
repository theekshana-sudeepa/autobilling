import type { Request } from 'express';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

export interface AuditInput {
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  actorId?: string | null;
  actorType?: 'USER' | 'SYSTEM';
  req?: Request;
}

const SENSITIVE = new Set(['passwordHash', 'smtpPassword', 'tokenHash', 'password']);

function scrub<T>(value: T): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(scrub);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE.has(k) ? '[redacted]' : scrub(v);
    }
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/**
 * Audit writes are best-effort and never block or fail the business action —
 * a dead audit table must not stop an invoice from being paid. Failures are
 * logged at error level so they surface in monitoring.
 */
export async function audit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        actorId: input.actorId ?? input.req?.user?.sub ?? null,
        actorType: input.actorType ?? (input.req?.user ? 'USER' : 'SYSTEM'),
        before: scrub(input.before) as never,
        after: scrub(input.after) as never,
        ip: input.req?.ip ?? null,
        userAgent: input.req?.headers['user-agent']?.slice(0, 250) ?? null,
      },
    });
  } catch (err) {
    logger.error({ err, action: input.action }, 'audit write failed');
  }
}
