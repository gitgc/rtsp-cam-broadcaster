import { describe, expect, it } from 'vitest'
import { makeCfg } from './test/fixtures.js'
import { buildTunnelArgs } from './tunnel.js'

describe('buildTunnelArgs', () => {
  it('runs a token-based tunnel — routing is configured in the dashboard', () => {
    const args = buildTunnelArgs(makeCfg({ tunnelToken: 'ey.secret' }))
    expect(args.slice(0, 3)).toEqual(['tunnel', '--no-autoupdate', 'run'])
    expect(args[args.indexOf('--token') + 1]).toBe('ey.secret')
  })

  it('passes the configured protocol through', () => {
    // The http2 default is what makes the tunnel work on home networks that
    // block outbound UDP :7844 and so break QUIC.
    expect(buildTunnelArgs(makeCfg()).at(-3)).toBe('http2')
    expect(buildTunnelArgs(makeCfg({ tunnelProtocol: 'quic' })).at(-3)).toBe('quic')
  })

  it('never auto-updates the pinned binary out from under us', () => {
    expect(buildTunnelArgs(makeCfg())).toContain('--no-autoupdate')
  })
})
