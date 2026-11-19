import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { disconnectPrisma, prisma } from './lib/prisma.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';
import { getSettings } from './modules/settings/settings.service.js';

async function bootstrap(): Promise<void> {
  await prisma.$connect();
  await getSettings(true); // create the singleton settings row on first boot

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV, appUrl: env.APP_URL }, '🚀 AutoBilling API listening');
  });

  server.keepAliveTimeout = 65_000; // must exceed the ALB/Nginx idle timeout
  server.headersTimeout = 70_000;

  startScheduler();

  /**
   * Graceful shutdown. Stopping the scheduler first means an in-flight billing
   * run finishes its current invoice rather than being killed halfway — the
   * job lock would otherwise stay RUNNING for 30 minutes and block the retry.
   */
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutdown initiated');
    stopScheduler();
    server.close(async (err) => {
      if (err) logger.error({ err }, 'error while closing http server');
      await disconnectPrisma();
      process.exit(err ? 1 : 0);
    });
    setTimeout(() => {
      logger.error('forced shutdown after 15s grace period');
      process.exit(1);
    }, 15_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandled promise rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception — exiting');
    process.exit(1);
  });
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'failed to start server');
  process.exit(1);
});
