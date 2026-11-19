/**
 * PM2 config for a single VPS.
 *
 * IMPORTANT: instances is 1, not "max". node-cron is in-process, so N
 * instances would fire N daily pipelines. The job lock in `job_runs` makes
 * that safe, but it is wasted work — scale horizontally only after moving the
 * scheduler out (see the roadmap: BullMQ + a dedicated worker).
 */
module.exports = {
  apps: [
    {
      name: 'autobilling-api',
      script: 'dist/server.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      env: { NODE_ENV: 'production' },
      error_file: 'logs/err.log',
      out_file: 'logs/out.log',
      time: true,
      kill_timeout: 16000,
      wait_ready: false,
      autorestart: true,
      max_restarts: 10,
    },
  ],
};
