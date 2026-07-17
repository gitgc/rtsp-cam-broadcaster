/**
 * cloudflared: runs the Cloudflare Tunnel that publishes the local HTTP server
 * to the internet. Using a tunnel *token* means the public hostname and routing
 * are configured once in the Cloudflare dashboard — the container just connects.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import { Supervisor } from './supervisor.js';

export function createTunnelSupervisor(cfg: Config, logger: FastifyBaseLogger): Supervisor {
  return new Supervisor({
    name: 'cloudflared',
    command: 'cloudflared',
    // The token itself is never logged (Supervisor logs "starting", not args).
    getArgs: () => ['tunnel', '--no-autoupdate', 'run', '--token', cfg.tunnelToken],
    logger,
    minBackoffMs: 2000,
    maxBackoffMs: 30000,
    onLine: (_stream, line) => logger.info(`cloudflared: ${line}`),
  });
}
