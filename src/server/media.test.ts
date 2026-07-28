import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFfmpegArgs, prepareHlsDir, startSegmentWatchdog } from './media.js'
import { makeCfg, recordingLogger } from './test/fixtures.js'

/** Index of a flag's value in an argv array. */
function valueOf(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag)
  return at === -1 ? undefined : args[at + 1]
}

describe('buildFfmpegArgs', () => {
  it('remuxes rather than re-encodes — the whole premise of the project', () => {
    const args = buildFfmpegArgs(makeCfg(), 'run0')
    expect(valueOf(args, '-c:v')).toBe('copy')
    expect(args).not.toContain('libx264')
  })

  it('drops audio by default and transcodes it to AAC when enabled', () => {
    expect(buildFfmpegArgs(makeCfg(), 'run0')).toContain('-an')

    const withAudio = buildFfmpegArgs(makeCfg({ enableAudio: true }), 'run0')
    expect(withAudio).not.toContain('-an')
    expect(valueOf(withAudio, '-c:a')).toBe('aac')
    // `0:a:0?` — the `?` makes the mapping optional, so a silent camera still works.
    expect(withAudio).toContain('0:a:0?')
  })

  it('passes transport, segment time and list size through from config', () => {
    const args = buildFfmpegArgs(
      makeCfg({ rtspTransport: 'udp', hlsSegmentTime: 4, hlsListSize: 12 }),
      'run0',
    )
    expect(valueOf(args, '-rtsp_transport')).toBe('udp')
    expect(valueOf(args, '-hls_time')).toBe('4')
    expect(valueOf(args, '-hls_list_size')).toBe('12')
  })

  it('gives each run a distinct segment prefix', () => {
    // Cloudflare may still be caching the previous run's segment names, so a
    // restart must not reuse them.
    const first = valueOf(buildFfmpegArgs(makeCfg(), 'aaa0'), '-hls_segment_filename')
    const second = valueOf(buildFfmpegArgs(makeCfg(), 'aaa1'), '-hls_segment_filename')

    expect(first).toMatch(/seg_aaa0_%d\.ts$/)
    expect(second).toMatch(/seg_aaa1_%d\.ts$/)
    expect(first).not.toBe(second)
  })

  it('writes the playlist and segments into the configured hlsDir', () => {
    const args = buildFfmpegArgs(makeCfg({ hlsDir: '/tmp/coop' }), 'run0')
    expect(args.at(-1)).toBe(path.join('/tmp/coop', 'stream.m3u8'))
    expect(valueOf(args, '-hls_segment_filename')).toBe(path.join('/tmp/coop', 'seg_run0_%d.ts'))
  })

  it('keeps the live playlist open and self-trimming', () => {
    const flags = valueOf(buildFfmpegArgs(makeCfg(), 'run0'), '-hls_flags')?.split('+') ?? []
    // delete_segments bounds the tmpfs; omit_endlist keeps it a *live* playlist;
    // independent_segments is what lets the CDN serve any segment standalone.
    expect(flags).toEqual(
      expect.arrayContaining([
        'delete_segments',
        'append_list',
        'omit_endlist',
        'independent_segments',
      ]),
    )
  })

  it('places FFMPEG_EXTRA_ARGS as output options, just before the playlist', () => {
    // ffmpeg is positional: anything after the output URL is ignored, and
    // output options must follow the input.
    const args = buildFfmpegArgs(makeCfg({ ffmpegExtraArgs: ['-muxdelay', '0'] }), 'run0')
    const extraAt = args.indexOf('-muxdelay')

    expect(extraAt).toBeGreaterThan(args.indexOf('-i'))
    expect(extraAt).toBe(args.length - 3)
    expect(args.at(-1)).toMatch(/stream\.m3u8$/)
  })
})

describe('prepareHlsDir', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cluckcam-media-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('creates the directory when it does not exist yet', async () => {
    const fresh = path.join(dir, 'nested', 'hls')
    await prepareHlsDir(fresh)
    expect(await readdir(fresh)).toEqual([])
  })

  it('clears segments and playlists left by a previous run', async () => {
    await writeFile(path.join(dir, 'seg_old_0.ts'), 'x')
    await writeFile(path.join(dir, 'stream.m3u8'), 'x')

    await prepareHlsDir(dir)

    expect(await readdir(dir)).toEqual([])
  })

  it('leaves unrelated files alone', async () => {
    // hlsDir may be a shared or bind-mounted directory — only our own output
    // is ours to delete.
    await writeFile(path.join(dir, 'seg_old_0.ts'), 'x')
    await writeFile(path.join(dir, 'notes.txt'), 'keep me')

    await prepareHlsDir(dir)

    expect(await readdir(dir)).toEqual(['notes.txt'])
  })
})

/** A stand-in for the ffmpeg Supervisor, with a controllable uptime. */
function fakeFfmpeg(uptimeMs: number) {
  return { uptimeMs: () => uptimeMs, bounce: vi.fn<(reason: string) => void>() }
}

describe('startSegmentWatchdog', () => {
  let dir: string
  let stop: (() => void) | undefined

  // staleMs = max(15000, hlsSegmentTime * 5000) = 15s with the default config.
  const STALE_MS = 15_000
  const TICK_MS = 10

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cluckcam-watchdog-'))
  })

  afterEach(async () => {
    stop?.()
    stop = undefined
    await rm(dir, { recursive: true, force: true })
  })

  async function writePlaylist(ageMs: number): Promise<void> {
    const file = path.join(dir, 'stream.m3u8')
    await writeFile(file, '#EXTM3U\n')
    const when = new Date(Date.now() - ageMs)
    await utimes(file, when, when)
  }

  it('bounces ffmpeg when the playlist stops advancing', async () => {
    const ffmpeg = fakeFfmpeg(STALE_MS * 2)
    await writePlaylist(STALE_MS + 5_000)

    stop = startSegmentWatchdog(makeCfg({ hlsDir: dir }), ffmpeg, recordingLogger().logger, TICK_MS)

    await vi.waitFor(() => expect(ffmpeg.bounce).toHaveBeenCalledWith('stale playlist'))
  })

  it('bounces ffmpeg when the playlist has vanished', async () => {
    const ffmpeg = fakeFfmpeg(STALE_MS * 2)
    await mkdir(dir, { recursive: true }) // dir exists, playlist does not

    stop = startSegmentWatchdog(makeCfg({ hlsDir: dir }), ffmpeg, recordingLogger().logger, TICK_MS)

    await vi.waitFor(() => expect(ffmpeg.bounce).toHaveBeenCalledWith('missing playlist'))
  })

  it('leaves a fresh playlist alone', async () => {
    const ffmpeg = fakeFfmpeg(STALE_MS * 2)
    await writePlaylist(0)

    stop = startSegmentWatchdog(makeCfg({ hlsDir: dir }), ffmpeg, recordingLogger().logger, TICK_MS)

    await new Promise((resolve) => setTimeout(resolve, TICK_MS * 8))
    expect(ffmpeg.bounce).not.toHaveBeenCalled()
  })

  it('gives a freshly restarted ffmpeg time to produce its first segments', async () => {
    // No playlist at all, but ffmpeg only just started — bouncing here would
    // create a restart loop that never lets it finish starting up.
    const ffmpeg = fakeFfmpeg(1_000)

    stop = startSegmentWatchdog(makeCfg({ hlsDir: dir }), ffmpeg, recordingLogger().logger, TICK_MS)

    await new Promise((resolve) => setTimeout(resolve, TICK_MS * 8))
    expect(ffmpeg.bounce).not.toHaveBeenCalled()
  })

  it('stops checking once the returned teardown runs', async () => {
    const ffmpeg = fakeFfmpeg(STALE_MS * 2)
    const teardown = startSegmentWatchdog(
      makeCfg({ hlsDir: dir }),
      ffmpeg,
      recordingLogger().logger,
      TICK_MS,
    )

    await vi.waitFor(() => expect(ffmpeg.bounce).toHaveBeenCalled())
    teardown()
    const callsAtTeardown = ffmpeg.bounce.mock.calls.length

    await new Promise((resolve) => setTimeout(resolve, TICK_MS * 8))
    expect(ffmpeg.bounce.mock.calls).toHaveLength(callsAtTeardown)
  })

  it('logs why it bounced, so the cause is visible in docker logs', async () => {
    const log = recordingLogger()
    const ffmpeg = fakeFfmpeg(STALE_MS * 2)
    await writePlaylist(STALE_MS + 20_000)

    stop = startSegmentWatchdog(makeCfg({ hlsDir: dir }), ffmpeg, log.logger, TICK_MS)

    await vi.waitFor(() => expect(ffmpeg.bounce).toHaveBeenCalled())
    expect(log.at('warn')).toContainEqual(expect.stringMatching(/playlist stale for \d+s/))
  })
})
