import type { FastifyBaseLogger } from 'fastify'
import type { Config } from '../config.js'

/** A fully-populated Config; override just the fields a test cares about. */
export function makeCfg(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    rtspUrl: 'rtsp://host/1',
    rtspTransport: 'tcp',
    tunnelToken: 't',
    tunnelProtocol: 'http2',
    hlsDir: '/nonexistent',
    hlsSegmentTime: 2,
    hlsListSize: 6,
    enableAudio: false,
    streamTitle: "Paul's Chickens",
    streamTagline: 'Live from the coop',
    logLevel: 'silent',
    ffmpegExtraArgs: [],
    frigate: {
      enabled: false,
      host: '',
      port: 1883,
      tls: false,
      topicPrefix: 'frigate',
      labels: ['bear', 'deer', 'dog', 'cat', 'bird', 'raccoon', 'fox', 'squirrel', 'rabbit'],
    },
    ...overrides,
  }
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface RecordingLogger {
  logger: FastifyBaseLogger
  /** Every message logged, in order, paired with its level. */
  entries: Array<{ level: LogLevel; message: string }>
  /** Just the messages logged at one level. */
  at(level: LogLevel): string[]
}

/**
 * A logger that captures messages instead of printing them.
 *
 * Pino's signature is `log.warn(obj?, message)`, so the object argument (if
 * any) is dropped and only the human-readable string is kept.
 */
export function recordingLogger(): RecordingLogger {
  const entries: Array<{ level: LogLevel; message: string }> = []

  const record =
    (level: LogLevel) =>
    (...args: unknown[]): void => {
      const message = args.find((arg) => typeof arg === 'string') ?? ''
      entries.push({ level, message })
    }

  const logger = {
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    child: () => logger,
  } as unknown as FastifyBaseLogger

  return {
    logger,
    entries,
    at: (level) => entries.filter((e) => e.level === level).map((e) => e.message),
  }
}
