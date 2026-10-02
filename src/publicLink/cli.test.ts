import { describe, expect, it } from 'vitest';
import { parsePublicLinkArgs } from './cli.js';

describe('public Link CLI surface', () => {
  it('exposes inspect, setup and local read-only runtime commands', () => {
    expect(parsePublicLinkArgs(['inspect', '--json'])).toEqual({ command: 'inspect', json: true });
    expect(parsePublicLinkArgs(['setup'])).toEqual({ command: 'setup' });
    expect(parsePublicLinkArgs(['run'])).toEqual({ command: 'run' });
  });

  it('has no integration, MCP or workspace-write CLI branches', () => {
    for (const argv of [
      ['integration', 'profiles'], ['mcp', 'list'], ['workspace-write-readiness'],
      ['pair', 'code', '--workspace-write', '--server', 'https://central.example.test']
    ]) expect(() => parsePublicLinkArgs(argv)).toThrow('Usage:');
  });

  it('uses hidden input or an explicit trusted pipe, never a pairing code in argv', () => {
    expect(parsePublicLinkArgs(['pair', '--server', 'https://central.example.test'])).toMatchObject({ command: 'pair', stdinCode: false });
    expect(parsePublicLinkArgs(['pair', '--server', 'https://central.example.test', '--code-stdin'])).toMatchObject({ command: 'pair', stdinCode: true });
    expect(() => parsePublicLinkArgs(['pair', 'secret-fixture', '--server', 'https://central.example.test'])).toThrow('Usage:');
  });
});
