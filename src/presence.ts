/**
 * In-memory live-viewer tracker. Each open page sends a periodic heartbeat with
 * a random per-session id; a viewer counts as "present" while their last
 * heartbeat is within `ttlMs`. No database, no held connections — just a Map
 * that's pruned on read. Resets to empty on restart and refills within one
 * heartbeat interval.
 */

export class Presence {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxSessions: number;

  constructor(ttlMs = 25000, maxSessions = 100000) {
    this.ttlMs = ttlMs;
    this.maxSessions = maxSessions;
  }

  /** Record a heartbeat and return the current live count. */
  heartbeat(id: string): number {
    // Bound memory: once at capacity, refresh known sessions but ignore new
    // ids (a public endpoint shouldn't be able to exhaust RAM with junk ids).
    if (this.seen.has(id) || this.seen.size < this.maxSessions) {
      this.seen.set(id, Date.now());
    }
    return this.count();
  }

  /** Drop a session immediately (sent via sendBeacon on tab close). */
  leave(id: string): number {
    this.seen.delete(id);
    return this.count();
  }

  /** Number of sessions seen within the TTL window. */
  count(): number {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, lastSeen] of this.seen) {
      if (lastSeen < cutoff) this.seen.delete(id);
    }
    return this.seen.size;
  }
}
