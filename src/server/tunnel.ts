/**
 * cloudflared: runs the Cloudflare Tunnel that publishes the local HTTP server
 * to the internet. Using a tunnel *token* means the public hostname and routing
 * are configured once in the Cloudflare dashboard — the container just connects.
 */

import type { FastifyBaseLogger } from 'fastify'
import type { Config } from './config.js'
import { Supervisor } from './supervisor.js'

/**
 * The cloudflared argument vector. `--no-autoupdate` keeps the pinned binary in
 * place, and `--protocol` is what makes the tunnel work on networks that block
 * outbound UDP :7844 (see TUNNEL_PROTOCOL in config.ts).
 */
export function buildTunnelArgs(cfg: Config): string[] {
  return [
    'tunnel',
    '--no-autoupdate',
    'run',
    '--protocol',
    cfg.tunnelProtocol,
    '--token',
    cfg.tunnelToken,
  ]
}

export function createTunnelSupervisor(cfg: Config, logger: FastifyBaseLogger): Supervisor {
  return new Supervisor({
    name: 'cloudflared',
    command: 'cloudflared',
    // The token itself is never logged (Supervisor logs "starting", not args).
    getArgs: () => buildTunnelArgs(cfg),
    logger,
    minBackoffMs: 2000,
    maxBackoffMs: 30000,
    onLine: (_stream, line) => logger.info(`cloudflared: ${line}`),
  })
}
