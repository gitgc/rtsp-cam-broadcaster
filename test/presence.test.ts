import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Presence } from '../src/presence.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Presence', () => {
  it('counts unique sessions and dedupes repeat heartbeats', () => {
    const p = new Presence();
    assert.equal(p.heartbeat('a'), 1);
    assert.equal(p.heartbeat('b'), 2);
    assert.equal(p.heartbeat('a'), 2); // same id — this is what localStorage relies on
  });

  it('leave() drops a session', () => {
    const p = new Presence();
    p.heartbeat('a');
    p.heartbeat('b');
    assert.equal(p.leave('a'), 1);
    assert.equal(p.count(), 1);
  });

  it('leave() on an unknown id is a no-op', () => {
    const p = new Presence();
    p.heartbeat('a');
    assert.equal(p.leave('ghost'), 1);
  });

  it('expires sessions after the TTL', async () => {
    const p = new Presence(20); // 20ms TTL
    p.heartbeat('a');
    assert.equal(p.count(), 1);
    await sleep(40);
    assert.equal(p.count(), 0);
  });

  it('a heartbeat within the TTL keeps a session alive', async () => {
    const p = new Presence(60);
    p.heartbeat('a');
    await sleep(30);
    p.heartbeat('a'); // refresh before expiry
    await sleep(30);
    assert.equal(p.count(), 1);
  });

  it('caps tracked sessions to bound memory', () => {
    const p = new Presence(25000, 2); // max 2 sessions
    assert.equal(p.heartbeat('a'), 1);
    assert.equal(p.heartbeat('b'), 2);
    assert.equal(p.heartbeat('c'), 2); // over cap — new id ignored
    assert.equal(p.heartbeat('a'), 2); // known id still refreshes fine
  });
});
