/**
 * ffmpeg pipeline: pull the RTSP stream and remux it into HLS.
 *
 * The video is copied straight through (`-c:v copy`) — no re-encode — so CPU
 * cost is near zero and quality is untouched. A watchdog restarts ffmpeg if it
 * silently stops producing segments (e.g. the camera drops the connection
 * without closing the socket).
 */

import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import { Supervisor } from './supervisor.js';

/** Substrings in ffmpeg output that indicate a non-transient failure. */
const FATAL_HINTS = [
  '401',
  '403',
  'unauthorized',
  'connection refused',
  'no route to host',
  'invalid data found',
  'could not find codec',
];

export function createFfmpegSupervisor(cfg: Config, logger: FastifyBaseLogger): Supervisor {
  // Unique per container boot + per restart, so segment filenames never collide
  // across runs — important because Cloudflare may still be caching old ones.
  const bootId = Date.now().toString(36);
  let runSeq = 0;

  const beforeStart = async (): Promise<void> => {
    await mkdir(cfg.hlsDir, { recursive: true });
    const entries = await readdir(cfg.hlsDir).catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter((f) => f.endsWith('.ts') || f.endsWith('.m3u8'))
        .map((f) => rm(path.join(cfg.hlsDir, f), { force: true })),
    );
  };

  const getArgs = (): string[] => {
    const runId = `${bootId}${(runSeq++).toString(36)}`;
    const playlist = path.join(cfg.hlsDir, 'stream.m3u8');
    const segmentPattern = path.join(cfg.hlsDir, `seg_${runId}_%d.ts`);
    const audio = cfg.enableAudio
      ? ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', '96k', '-ac', '2']
      : ['-an'];

    return [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'warning',
      '-rtsp_transport',
      cfg.rtspTransport,
      '-i',
      cfg.rtspUrl,
      '-map',
      '0:v:0',
      ...audio,
      '-c:v',
      'copy',
      '-f',
      'hls',
      '-hls_time',
      String(cfg.hlsSegmentTime),
      '-hls_list_size',
      String(cfg.hlsListSize),
      '-hls_flags',
      'delete_segments+append_list+omit_endlist+independent_segments',
      '-hls_segment_type',
      'mpegts',
      '-hls_segment_filename',
      segmentPattern,
      ...cfg.ffmpegExtraArgs,
      playlist,
    ];
  };

  return new Supervisor({
    name: 'ffmpeg',
    command: 'ffmpeg',
    getArgs,
    beforeStart,
    logger,
    minBackoffMs: 1000,
    maxBackoffMs: 20000,
    onLine: (_stream, line) => {
      const lower = line.toLowerCase();
      if (FATAL_HINTS.some((hint) => lower.includes(hint))) logger.error(`ffmpeg: ${line}`);
      else logger.debug(`ffmpeg: ${line}`);
    },
  });
}

/**
 * Restarts ffmpeg if the playlist stops advancing. Returns a stop function.
 */
export function startSegmentWatchdog(
  cfg: Config,
  ffmpeg: Supervisor,
  logger: FastifyBaseLogger,
): () => void {
  const playlist = path.join(cfg.hlsDir, 'stream.m3u8');
  const staleMs = Math.max(15000, cfg.hlsSegmentTime * 1000 * 5);

  const timer = setInterval(() => {
    void (async () => {
      // Give a freshly (re)started ffmpeg time to produce its first segments.
      if (ffmpeg.uptimeMs() < staleMs) return;
      try {
        const stats = await stat(playlist);
        const ageMs = Date.now() - stats.mtimeMs;
        if (ageMs > staleMs) {
          logger.warn(`playlist stale for ${Math.round(ageMs / 1000)}s`);
          ffmpeg.bounce('stale playlist');
        }
      } catch {
        logger.warn('playlist missing while ffmpeg is up');
        ffmpeg.bounce('missing playlist');
      }
    })();
  }, 5000);
  timer.unref?.();

  return () => clearInterval(timer);
}
