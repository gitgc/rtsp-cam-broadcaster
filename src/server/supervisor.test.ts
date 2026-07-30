import { describe, expect, it, vi } from 'vitest'
import { Supervisor, type SupervisorOptions } from './supervisor.js'
import { recordingLogger, type RecordingLogger } from './test/fixtures.js'

/**
 * These drive real child processes rather than a mocked `spawn`, because the
 * behaviour that matters here — exit handling, signal delivery, line buffering
 * — only exists at the OS boundary. Node itself is the guinea pig.
 */

/** Exits immediately with a failure code. */
const DIES = ['-e', 'process.exit(1)']
/** Stays up until signalled. */
const LIVES = ['-e', 'setInterval(() => {}, 1000)']

interface Harness {
  supervisor: Supervisor
  log: RecordingLogger
  /** How many times a child has been (re)started. */
  spawns: () => number
}

function harness(args: string[], overrides: Partial<SupervisorOptions> = {}): Harness {
  const log = recordingLogger()
  let spawns = 0

  const supervisor = new Supervisor({
    name: 'test',
    command: process.execPath,
    getArgs: () => {
      spawns += 1
      return args
    },
    logger: log.logger,
    minBackoffMs: 10,
    maxBackoffMs: 40,
    // High by default so `failures` accumulates instead of resetting; the
    // backoff-reset test lowers it deliberately.
    stableMs: 60_000,
    killGraceMs: 200,
    ...overrides,
  })

  return { supervisor, log, spawns: () => spawns }
}

/** Delays logged by scheduleRestart, in order. */
function restartDelays(log: RecordingLogger): number[] {
  return log
    .at('debug')
    .map((m) => /restarting in (\d+)ms/.exec(m)?.[1])
    .filter((d): d is string => d !== undefined)
    .map(Number)
}

describe('Supervisor', () => {
  it('restarts a child that exits on its own', async () => {
    const { supervisor, spawns } = harness(DIES)
    await supervisor.start()

    await vi.waitFor(() => expect(spawns()).toBeGreaterThanOrEqual(3), { timeout: 5000 })
    await supervisor.stop()
  })

  it('reports uptime only while a child is actually running', async () => {
    const { supervisor } = harness(LIVES)
    expect(supervisor.uptimeMs()).toBe(0)

    await supervisor.start()
    await vi.waitFor(() => expect(supervisor.uptimeMs()).toBeGreaterThan(0))

    await supervisor.stop()
    expect(supervisor.uptimeMs()).toBe(0)
  })

  it('stop() terminates the child and prevents further restarts', async () => {
    const { supervisor, spawns } = harness(LIVES)
    await supervisor.start()
    await vi.waitFor(() => expect(supervisor.uptimeMs()).toBeGreaterThan(0))

    await supervisor.stop()
    const afterStop = spawns()

    // Well past the 10ms backoff — nothing should have come back.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(spawns()).toBe(afterStop)
  })

  it('does not spawn a child when stop() lands during beforeStart', async () => {
    // beforeStart does real async I/O (prepareHlsDir wipes the segment dir), so
    // there is a genuine window where stop() sees no child yet, returns, and an
    // unguarded spawn would then leave an orphan nothing ever kills.
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const { supervisor, log } = harness(LIVES, { beforeStart: () => blocked })

    const starting = supervisor.start()
    await supervisor.stop()
    release?.()
    await starting

    expect(log.at('debug')).not.toContain('test: starting')
    expect(supervisor.uptimeMs()).toBe(0)
  })

  it('bounce() kills a wedged child and the exit handler brings it back', async () => {
    const { supervisor, spawns, log } = harness(LIVES)
    await supervisor.start()
    await vi.waitFor(() => expect(supervisor.uptimeMs()).toBeGreaterThan(0))
    expect(spawns()).toBe(1)

    supervisor.bounce('stale playlist')

    await vi.waitFor(() => expect(spawns()).toBe(2), { timeout: 5000 })
    expect(log.at('warn')).toContainEqual(expect.stringContaining('bouncing (stale playlist)'))
    await supervisor.stop()
  })

  it('bounce() on a stopped supervisor is a no-op', async () => {
    const { supervisor, spawns, log } = harness(LIVES)

    supervisor.bounce('nothing running')

    expect(spawns()).toBe(0)
    expect(log.entries).toHaveLength(0)
  })

  it('forwards child stdout and stderr line by line', async () => {
    const lines: Array<[string, string]> = []
    const { supervisor } = harness(
      ['-e', 'console.log("first\\nsecond"); console.error("oops"); setInterval(() => {}, 1000)'],
      { onLine: (stream, line) => lines.push([stream, line]) },
    )

    await supervisor.start()

    await vi.waitFor(() => expect(lines).toHaveLength(3), { timeout: 5000 })
    expect(lines).toContainEqual(['stdout', 'first'])
    expect(lines).toContainEqual(['stdout', 'second']) // split, not one blob
    expect(lines).toContainEqual(['stderr', 'oops'])
    await supervisor.stop()
  })

  it('runs beforeStart and rebuilds arguments on every start', async () => {
    const order: string[] = []
    const log = recordingLogger()
    let run = 0

    const supervisor = new Supervisor({
      name: 'test',
      command: process.execPath,
      beforeStart: () => {
        order.push('before')
      },
      getArgs: () => {
        order.push(`args:${run++}`)
        return DIES
      },
      logger: log.logger,
      minBackoffMs: 10,
      maxBackoffMs: 20,
      stableMs: 60_000,
      killGraceMs: 200,
    })

    await supervisor.start()
    await vi.waitFor(() => expect(order.length).toBeGreaterThanOrEqual(4), { timeout: 5000 })
    await supervisor.stop()

    // beforeStart always precedes the args for that same run — that ordering is
    // what lets ffmpeg's hlsDir be wiped before the new run writes into it.
    expect(order.slice(0, 4)).toEqual(['before', 'args:0', 'before', 'args:1'])
  })

  it('keeps retrying when building arguments throws', async () => {
    const log = recordingLogger()
    let attempts = 0

    const supervisor = new Supervisor({
      name: 'test',
      command: process.execPath,
      getArgs: () => {
        attempts += 1
        throw new Error('bad config')
      },
      logger: log.logger,
      minBackoffMs: 10,
      maxBackoffMs: 20,
      killGraceMs: 200,
    })

    await supervisor.start()
    await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(3), { timeout: 5000 })
    await supervisor.stop()

    expect(log.at('error')).toContainEqual(expect.stringContaining('failed to build arguments'))
  })

  it('backs off exponentially up to the ceiling', async () => {
    const { supervisor, log } = harness(DIES)
    await supervisor.start()

    await vi.waitFor(() => expect(restartDelays(log).length).toBeGreaterThanOrEqual(4), {
      timeout: 5000,
    })
    await supervisor.stop()

    // 10 -> 20 -> 40, then held at maxBackoffMs.
    expect(restartDelays(log).slice(0, 4)).toEqual([10, 20, 40, 40])
  })

  it('resets the backoff once a run has been stable', async () => {
    // stableMs of 1ms means every run counts as stable, so the delay never grows.
    const { supervisor, log } = harness(DIES, { stableMs: 1 })
    await supervisor.start()

    await vi.waitFor(() => expect(restartDelays(log).length).toBeGreaterThanOrEqual(4), {
      timeout: 5000,
    })
    await supervisor.stop()

    expect(restartDelays(log).slice(0, 4)).toEqual([10, 10, 10, 10])
  })

  it('throttles failure logging so an outage does not spew forever', async () => {
    const { supervisor, log, spawns } = harness(DIES)
    await supervisor.start()

    await vi.waitFor(() => expect(spawns()).toBeGreaterThanOrEqual(6), { timeout: 5000 })
    await supervisor.stop()

    // The first three exits are warned about; the rest drop to debug until the
    // every-20th reminder.
    const exitWarnings = log.at('warn').filter((m) => m.includes('exited'))
    expect(exitWarnings).toHaveLength(3)
  })
})
