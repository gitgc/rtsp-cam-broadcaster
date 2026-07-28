import { describe, expect, it } from 'vitest'
import { Presence } from './presence.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('Presence', () => {
  it('counts unique sessions and dedupes repeat heartbeats', () => {
    const p = new Presence()
    expect(p.heartbeat('a')).toBe(1)
    expect(p.heartbeat('b')).toBe(2)
    expect(p.heartbeat('a')).toBe(2) // same id — this is what localStorage relies on
  })

  it('leave() drops a session', () => {
    const p = new Presence()
    p.heartbeat('a')
    p.heartbeat('b')
    expect(p.leave('a')).toBe(1)
    expect(p.count()).toBe(1)
  })

  it('leave() on an unknown id is a no-op', () => {
    const p = new Presence()
    p.heartbeat('a')
    expect(p.leave('ghost')).toBe(1)
  })

  it('expires sessions after the TTL', async () => {
    const p = new Presence(20) // 20ms TTL
    p.heartbeat('a')
    expect(p.count()).toBe(1)
    await sleep(40)
    expect(p.count()).toBe(0)
  })

  it('a heartbeat within the TTL keeps a session alive', async () => {
    const p = new Presence(60)
    p.heartbeat('a')
    await sleep(30)
    p.heartbeat('a') // refresh before expiry
    await sleep(30)
    expect(p.count()).toBe(1)
  })

  it('caps tracked sessions to bound memory', () => {
    const p = new Presence(25000, 2) // max 2 sessions
    expect(p.heartbeat('a')).toBe(1)
    expect(p.heartbeat('b')).toBe(2)
    expect(p.heartbeat('c')).toBe(2) // over cap — new id ignored
    expect(p.heartbeat('a')).toBe(2) // known id still refreshes fine
  })
})
