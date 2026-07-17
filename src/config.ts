/**
 * Runtime configuration, parsed and validated from environment variables.
 *
 * Only RTSP_URL and TUNNEL_TOKEN are required — everything else has a sensible
 * default so the image is genuinely "two vars and go".
 */

import os from 'node:os';
import path from 'node:path';

export interface Config {
  port: number;
  rtspUrl: string;
  rtspTransport: string;
  tunnelToken: string;
  tunnelProtocol: string;
  hlsDir: string;
  hlsSegmentTime: number;
  hlsListSize: number;
  enableAudio: boolean;
  streamTitle: string;
  streamTagline: string;
  logLevel: string;
  ffmpegExtraArgs: string[];
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function numeric(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got "${value}"`);
  }
  return parsed;
}

function boolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

/**
 * Expands ${VAR} references inside a string using the current environment.
 * Lets RTSP_URL keep credentials in separate vars, e.g.
 *   RTSP_URL=rtsp://${FRIGATE_RTSP_USER}:${FRIGATE_RTSP_PASSWORD}@host/...
 */
export function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined) {
      throw new Error(`RTSP_URL references \${${name}} but ${name} is not set`);
    }
    return resolved;
  });
}

/** Masks credentials in an RTSP URL so it is safe to log. */
export function redactRtsp(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username) parsed.username = '***';
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return url.replace(/\/\/[^@/]+@/, '//***:***@');
  }
}

export function loadConfig(): Config {
  const rtspUrl = expandEnv(required('RTSP_URL'));
  if (!/^rtsps?:\/\//i.test(rtspUrl)) {
    throw new Error('RTSP_URL must start with rtsp:// or rtsps://');
  }

  const extra = optional('FFMPEG_EXTRA_ARGS', '').trim();

  return {
    port: numeric('PORT', 8080),
    rtspUrl,
    rtspTransport: optional('RTSP_TRANSPORT', 'tcp'),
    tunnelToken: required('TUNNEL_TOKEN'),
    // http2 (plain TCP 443) is the most firewall-friendly default. Many home
    // networks block outbound UDP :7844, which makes the default QUIC transport
    // fail its handshake and the tunnel never connects.
    tunnelProtocol: optional('TUNNEL_PROTOCOL', 'http2'),
    // Docker sets HLS_DIR=/hls (a writable tmpfs). Locally, default to a
    // writable temp dir — a plain user can't create /hls on macOS/Linux.
    hlsDir: optional('HLS_DIR', path.join(os.tmpdir(), 'cluckcam-hls')),
    hlsSegmentTime: numeric('HLS_SEGMENT_TIME', 2),
    hlsListSize: numeric('HLS_LIST_SIZE', 6),
    enableAudio: boolean('ENABLE_AUDIO', false),
    streamTitle: optional('STREAM_TITLE', "Paul's Chickens"),
    streamTagline: optional('STREAM_TAGLINE', 'Live from the coop 🐔'),
    logLevel: optional('LOG_LEVEL', 'info'),
    ffmpegExtraArgs: extra ? extra.split(/\s+/) : [],
  };
}
