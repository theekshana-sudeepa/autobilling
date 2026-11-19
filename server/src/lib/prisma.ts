import { PrismaClient } from '@prisma/client';
import { env, isProd } from '../config/env.js';
import { logger } from './logger.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isProd
      ? [{ emit: 'event', level: 'error' }, { emit: 'event', level: 'warn' }]
      : [{ emit: 'event', level: 'query' }, { emit: 'event', level: 'error' }, { emit: 'event', level: 'warn' }],
  });

prisma.$on('error' as never, (e: unknown) => logger.error({ e }, 'prisma error'));
prisma.$on('warn' as never, (e: unknown) => logger.warn({ e }, 'prisma warn'));

if (!isProd) globalForPrisma.prisma = prisma;

/** MySQL duplicate-key error code surfaced by Prisma. */
export const P2002_UNIQUE_VIOLATION = 'P2002';

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === P2002_UNIQUE_VIOLATION;
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
  logger.info({ env: env.NODE_ENV }, 'prisma disconnected');
}
