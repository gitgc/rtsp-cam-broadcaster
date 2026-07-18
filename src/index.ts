/**
 * Entry point. Starts the HTTP server, then supervises the ffmpeg (RTSP→HLS)
 * and cloudflared (tunnel) child processes, wiring up a segment watchdog and
 * graceful shutdown. Node is PID 1's child (via tini), so signals arrive here.
 */

import { existsSync } from 'node:fs';
import { loadConfig, redactRtsp } from './config.js';
import { buildServer } from './server.js';
import { createFfmpegSupervisor, startSegmentWatchdog } from './media.js';
import { createTunnelSupervisor } from './tunnel.js';
import { FrigateEvents } from './frigate.js';

/**
 * Load a local .env file when present (dev convenience for `npm start`/`dev`).
 * In Docker the vars are injected by compose's `env_file:` and no .env exists,
 * so this is a no-op there. Values already in the environment win — the file
 * only fills in what's missing.
 */
function loadDotEnv(): void {
  const file = process.env.ENV_FILE ?? '.env';
  if (!existsSync(file)) return;
  const preset = new Map(Object.entries(process.env));
  process.loadEnvFile(file);
  // Vars already set in the real environment win over the file (dotenv convention).
  for (const [key, value] of preset) {
    process.env[key] = value;
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig();

  // Frigate is created after the server so it can use the app logger, but the
  // routes need to reach it — a getter bridges that ordering.
  let frigate: FrigateEvents | undefined;
  const app = await buildServer(cfg, () => frigate);
  const log = app.log;

  log.info(
    { camera: redactRtsp(cfg.rtspUrl), port: cfg.port, hlsDir: cfg.hlsDir, audio: cfg.enableAudio },
    'starting cluckcam broadcaster',
  );

  if (cfg.frigate.enabled) {
    frigate = new FrigateEvents(cfg.frigate, log.child({ module: 'frigate' }));
    frigate.start();
    log.info({ labels: cfg.frigate.labels, camera: cfg.frigate.camera ?? 'any' }, 'frigate enabled');
  }

  const ffmpeg = createFfmpegSupervisor(cfg, log.child({ module: 'ffmpeg' }));
  const tunnel = createTunnelSupervisor(cfg, log.child({ module: 'cloudflared' }));

  await app.listen({ host: '0.0.0.0', port: cfg.port });
  await ffmpeg.start();
  const stopWatchdog = startSegmentWatchdog(cfg, ffmpeg, log.child({ module: 'watchdog' }));
  await tunnel.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}, shutting down`);
    stopWatchdog();
    await Promise.allSettled([tunnel.stop(), ffmpeg.stop(), frigate?.stop() ?? Promise.resolve()]);
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    log.error({ err }, 'uncaughtException');
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (err) => log.error({ err }, 'unhandledRejection'));
}

main().catch((err) => {
  console.error('fatal startup error:', err);
  process.exit(1);
});
