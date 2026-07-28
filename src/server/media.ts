/**
 * ffmpeg pipeline: pull the RTSP stream and remux it into HLS.
 *
 * The video is copied straight through (`-c:v copy`) — no re-encode — so CPU
 * cost is near zero and quality is untouched. A watchdog restarts ffmpeg if it
 * silently stops producing segments (e.g. the camera drops the connection
 * without closing the socket).
 */

import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { FastifyBaseLogger } from 'fastify'
import type { Config } from './config.js'
import { Supervisor } from './supervisor.js'

/** Substrings in ffmpeg output that indicate a non-transient failure. */
const FATAL_HINTS = [
  '401',
  '403',
  'unauthorized',
  'connection refused',
  'no route to host',
  'invalid data found',
  'could not find codec',
]

/**
 * Wipes any playlist/segments left by a previous run (and creates the directory
 * if needed), so a restart never serves a mix of two runs' segments.
 */
export async function prepareHlsDir(hlsDir: string): Promise<void> {
  await mkdir(hlsDir, { recursive: true })
  const entries = await readdir(hlsDir).catch(() => [] as string[])
  await Promise.all(
    entries
      .filter((f) => f.endsWith('.ts') || f.endsWith('.m3u8'))
      .map((f) => rm(path.join(hlsDir, f), { force: true })),
  )
}

/**
 * The ffmpeg argument vector for one run. `runId` makes segment filenames
 * unique per run, which matters because Cloudflare may still be caching the
 * previous run's segments under the old names.
 */
export function buildFfmpegArgs(cfg: Config, runId: string): string[] {
  const audio = cfg.enableAudio
    ? ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', '96k', '-ac', '2']
    : ['-an']

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
    // The whole premise: remux, never re-encode.
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
    path.join(cfg.hlsDir, `seg_${runId}_%d.ts`),
    ...cfg.ffmpegExtraArgs,
    path.join(cfg.hlsDir, 'stream.m3u8'),
  ]
}

export function createFfmpegSupervisor(cfg: Config, logger: FastifyBaseLogger): Supervisor {
  // Unique per container boot + per restart.
  const bootId = Date.now().toString(36)
  let runSeq = 0

  const beforeStart = (): Promise<void> => prepareHlsDir(cfg.hlsDir)
  const getArgs = (): string[] => buildFfmpegArgs(cfg, `${bootId}${(runSeq++).toString(36)}`)

  return new Supervisor({
    name: 'ffmpeg',
    command: 'ffmpeg',
    getArgs,
    beforeStart,
    logger,
    minBackoffMs: 1000,
    maxBackoffMs: 20000,
    onLine: (_stream, line) => {
      const lower = line.toLowerCase()
      if (FATAL_HINTS.some((hint) => lower.includes(hint))) logger.error(`ffmpeg: ${line}`)
      else logger.debug(`ffmpeg: ${line}`)
    },
  })
}

/** The part of {@link Supervisor} the watchdog needs — lets tests inject a stub. */
export type WatchedProcess = Pick<Supervisor, 'uptimeMs' | 'bounce'>

/**
 * Restarts ffmpeg if the playlist stops advancing. Returns a stop function.
 *
 * `intervalMs` is a test seam; production always uses the default.
 */
export function startSegmentWatchdog(
  cfg: Config,
  ffmpeg: WatchedProcess,
  logger: FastifyBaseLogger,
  intervalMs = 5000,
): () => void {
  const playlist = path.join(cfg.hlsDir, 'stream.m3u8')
  const staleMs = Math.max(15000, cfg.hlsSegmentTime * 1000 * 5)

  const timer = setInterval(() => {
    void (async () => {
      // Give a freshly (re)started ffmpeg time to produce its first segments.
      if (ffmpeg.uptimeMs() < staleMs) return
      try {
        const stats = await stat(playlist)
        const ageMs = Date.now() - stats.mtimeMs
        if (ageMs > staleMs) {
          logger.warn(`playlist stale for ${Math.round(ageMs / 1000)}s`)
          ffmpeg.bounce('stale playlist')
        }
      } catch {
        logger.warn('playlist missing while ffmpeg is up')
        ffmpeg.bounce('missing playlist')
      }
    })()
  }, intervalMs)
  timer.unref?.()

  return () => clearInterval(timer)
}
