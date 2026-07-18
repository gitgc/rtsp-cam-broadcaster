import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FrigateEvents } from '../src/frigate.js';
import type { FrigateSettings } from '../src/config.js';

// FrigateEvents only touches the logger in start(); the ingest methods don't,
// so a no-op stub is enough for these unit tests.
const noopLog = {
  info() {}, warn() {}, debug() {}, error() {},
  child() {
    return noopLog;
  },
} as unknown as Parameters<typeof FrigateEvents.prototype.constructor>[1];

const SETTINGS: FrigateSettings = {
  enabled: true,
  host: 'x',
  port: 1883,
  tls: false,
  topicPrefix: 'frigate',
  labels: ['bear', 'deer', 'dog', 'cat', 'bird', 'raccoon', 'fox', 'squirrel', 'rabbit'],
};

function event(label: string, extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: 'end',
      after: { label, camera: 'roaming', start_time: 1700000000, frame_time: 1700000005, score: 0.9, ...extra },
    }),
  );
}

describe('FrigateEvents', () => {
  it('surfaces a target detection once it has an event and a snapshot', () => {
    const f = new FrigateEvents(SETTINGS, noopLog);
    f.ingestEvent(event('deer'));
    assert.equal(f.list().length, 0); // metadata only, no image yet

    f.ingestSnapshot('frigate/roaming/deer/snapshot', Buffer.from('jpeg'), false);
    const list = f.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.label, 'deer');
    assert.equal(list[0]?.lastSeen, 1700000005 * 1000);
    assert.ok(f.getImage('deer'));
  });

  it('ignores labels outside the configured set', () => {
    const f = new FrigateEvents(SETTINGS, noopLog);
    f.ingestEvent(event('person'));
    f.ingestSnapshot('frigate/roaming/person/snapshot', Buffer.from('x'), false);
    assert.equal(f.list().length, 0);
    assert.equal(f.getImage('person'), undefined);
  });

  it('ignores false positives', () => {
    const f = new FrigateEvents(SETTINGS, noopLog);
    f.ingestEvent(event('bear', { false_positive: true }));
    f.ingestSnapshot('frigate/roaming/bear/snapshot', Buffer.from('x'), false);
    // snapshot still stores the image, but no valid event set a time
    assert.equal(f.list()[0]?.lastSeen, f.list()[0]?.imageAt);
  });

  it('filters by camera when configured', () => {
    const f = new FrigateEvents({ ...SETTINGS, camera: 'roaming' }, noopLog);
    f.ingestEvent(event('fox', { camera: 'driveway' }));
    f.ingestSnapshot('frigate/driveway/fox/snapshot', Buffer.from('x'), false);
    assert.equal(f.list().length, 0);

    f.ingestEvent(event('fox', { camera: 'roaming' }));
    f.ingestSnapshot('frigate/roaming/fox/snapshot', Buffer.from('x'), false);
    assert.equal(f.list().length, 1);
  });

  it('sorts most-recent first and ignores empty snapshot payloads', () => {
    const f = new FrigateEvents(SETTINGS, noopLog);
    f.ingestEvent(event('cat', { frame_time: 1700000001 }));
    f.ingestSnapshot('frigate/roaming/cat/snapshot', Buffer.from('c'), false);
    f.ingestEvent(event('dog', { frame_time: 1700000100 }));
    f.ingestSnapshot('frigate/roaming/dog/snapshot', Buffer.from('d'), false);
    f.ingestSnapshot('frigate/roaming/dog/snapshot', Buffer.alloc(0), false); // empty -> ignored

    const list = f.list();
    assert.equal(list[0]?.label, 'dog'); // newer frame_time
    assert.equal(list[1]?.label, 'cat');
    assert.equal(f.getImage('dog')?.toString(), 'd'); // kept the real image
  });

  it('does not fabricate a timestamp from a retained snapshot', () => {
    const f = new FrigateEvents(SETTINGS, noopLog);
    f.ingestSnapshot('frigate/roaming/raccoon/snapshot', Buffer.from('r'), true); // retained
    const list = f.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.lastSeen, 0); // unknown time -> "recently" in the UI
  });

  it('ignores malformed event JSON', () => {
    const f = new FrigateEvents(SETTINGS, noopLog);
    f.ingestEvent(Buffer.from('not json'));
    assert.equal(f.list().length, 0);
  });
});
