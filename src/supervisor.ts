/**
 * A tiny process supervisor: keeps a long-running child process alive,
 * restarting it with exponential backoff when it dies, and forwarding its
 * output line-by-line to the logger. Used for both ffmpeg and cloudflared.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';

export interface SupervisorOptions {
  /** Human-readable name used in logs. */
  name: string;
  /** Executable to run. */
  command: string;
  /** Built fresh on every (re)start — lets callers vary args between runs. */
  getArgs: () => string[] | Promise<string[]>;
  logger: FastifyBaseLogger;
  /** Runs before each (re)start, e.g. to prepare a working directory. */
  beforeStart?: () => void | Promise<void>;
  /** Receives every stdout/stderr line. Defaults to debug-level logging. */
  onLine?: (stream: 'stdout' | 'stderr', line: string) => void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Uptime after which the backoff counter resets to the minimum. */
  stableMs?: number;
  /** Grace period between SIGTERM and SIGKILL on stop(). */
  killGraceMs?: number;
}

export class Supervisor {
  private readonly name: string;
  private readonly command: string;
  private readonly getArgs: () => string[] | Promise<string[]>;
  private readonly log: FastifyBaseLogger;
  private readonly beforeStart?: () => void | Promise<void>;
  private readonly onLine?: (stream: 'stdout' | 'stderr', line: string) => void;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly stableMs: number;
  private readonly killGraceMs: number;

  private child: ChildProcess | null = null;
  private stopping = false;
  private backoffMs: number;
  private startedAt = 0;
  private failures = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SupervisorOptions) {
    this.name = options.name;
    this.command = options.command;
    this.getArgs = options.getArgs;
    this.log = options.logger;
    this.beforeStart = options.beforeStart;
    this.onLine = options.onLine;
    this.minBackoffMs = options.minBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30000;
    this.stableMs = options.stableMs ?? 15000;
    this.killGraceMs = options.killGraceMs ?? 8000;
    this.backoffMs = this.minBackoffMs;
  }

  /** Milliseconds the current child has been alive (0 if not running). */
  uptimeMs(): number {
    return this.child ? Date.now() - this.startedAt : 0;
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.spawnOnce();
  }

  /** Force a restart of a wedged process; the exit handler reschedules it. */
  bounce(reason: string): void {
    if (!this.child) return;
    this.log.warn(`${this.name}: bouncing (${reason})`);
    this.child.kill('SIGKILL');
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), this.killGraceMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  private async spawnOnce(): Promise<void> {
    if (this.stopping) return;

    try {
      await this.beforeStart?.();
    } catch (err) {
      this.log.error({ err }, `${this.name}: beforeStart failed`);
    }

    let args: string[];
    try {
      args = await this.getArgs();
    } catch (err) {
      this.log.error({ err }, `${this.name}: failed to build arguments`);
      this.scheduleRestart();
      return;
    }

    this.log.debug(`${this.name}: starting`);
    let child: ChildProcess;
    try {
      child = spawn(this.command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this.log.error({ err }, `${this.name}: spawn failed`);
      this.scheduleRestart();
      return;
    }

    this.child = child;
    this.startedAt = Date.now();
    if (child.stdout) this.forward(child.stdout, 'stdout');
    if (child.stderr) this.forward(child.stderr, 'stderr');

    child.on('error', (err) => this.log.error({ err }, `${this.name}: process error`));
    child.on('exit', (code, signal) => {
      const uptime = Date.now() - this.startedAt;
      this.child = null;
      if (this.stopping) {
        this.log.info(`${this.name}: stopped (code=${code ?? ''} signal=${signal ?? ''})`);
        return;
      }
      if (uptime >= this.stableMs) {
        this.backoffMs = this.minBackoffMs;
        this.failures = 0;
      }
      this.failures += 1;
      const detail = `exited (code=${code ?? ''} signal=${signal ?? ''}) after ${Math.round(uptime / 1000)}s`;
      // Log the first few failures loudly, then throttle: a sustained outage
      // (camera offline, network down) shouldn't spew identical lines forever.
      if (this.failures <= 3) {
        this.log.warn(`${this.name}: ${detail}`);
      } else if (this.failures % 20 === 0) {
        this.log.warn(`${this.name}: still failing after ${this.failures} attempts — ${detail}`);
      } else {
        this.log.debug(`${this.name}: ${detail}`);
      }
      this.scheduleRestart();
    });
  }

  private forward(stream: Readable, which: 'stdout' | 'stderr'): void {
    const rl = createInterface({ input: stream });
    rl.on('line', (line) => {
      if (this.onLine) this.onLine(which, line);
      else this.log.debug(`${this.name}: ${line}`);
    });
  }

  private scheduleRestart(): void {
    if (this.stopping) return;
    const delay = this.backoffMs;
    this.log.debug(`${this.name}: restarting in ${delay}ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      void this.spawnOnce();
    }, delay);
  }
}
