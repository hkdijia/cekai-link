import { afterEach, describe, expect, it, vi } from 'vitest';
import { main, parsePublicLinkArgs } from './cli.js';
import * as config from './config.js';
import * as api from './api.js';
import * as runtime from './runtime.js';
import * as identity from './packageIdentity.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('public Link CLI surface', () => {
  it('exposes inspect, setup and local read-only runtime commands', () => {
    expect(parsePublicLinkArgs(['inspect', '--json'])).toEqual({ command: 'inspect', json: true });
    expect(parsePublicLinkArgs(['setup'])).toEqual({ command: 'setup' });
    expect(parsePublicLinkArgs(['run'])).toEqual({ command: 'run' });
    for (const action of ['install', 'start', 'status', 'stop', 'uninstall']) {
      expect(parsePublicLinkArgs(['service', action])).toEqual({ command: 'service', action });
    }
    expect(parsePublicLinkArgs(['update', '1.0.1'])).toEqual({ command: 'update', update: { action: 'apply', target: '1.0.1', yes: false } });
    expect(parsePublicLinkArgs(['update', 'rollback', '--yes'])).toEqual({ command: 'update', update: { action: 'rollback', yes: true } });
    expect(parsePublicLinkArgs(['update', 'resume'])).toEqual({ command: 'update', update: { action: 'resume', yes: false } });
    expect(parsePublicLinkArgs(['service', 'install', '--disabled'])).toEqual({ command: 'service-install-disabled' });
    for (const argv of [['update', 'latest'], ['update', '^1.0.0'], ['update', '1.0.1', '--yes', '--yes'], ['update', 'status', '--yes']]) expect(() => parsePublicLinkArgs(argv)).toThrow('Usage:');
    for (const argv of [['service'], ['service', 'update'], ['service', 'install', '--force'], ['service', 'status', '--json', '--json']]) {
      expect(() => parsePublicLinkArgs(argv)).toThrow('Usage:');
    }
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

  it('serves offline help and version before any config, Central or runtime work', async () => {
    const store = vi.spyOn(config, 'createPublicLinkConfigStore').mockImplementation(() => { throw new Error('Unexpected config access'); });
    const central = vi.spyOn(api, 'createPublicLinkApi').mockImplementation(() => { throw new Error('Unexpected Central access'); });
    const serve = vi.spyOn(runtime, 'createPublicLinkRuntime').mockImplementation(() => { throw new Error('Unexpected runtime start'); });
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const verify = vi.spyOn(identity, 'verifyPublicSourcePackage').mockReturnValue({ schemaVersion: 1, kind: 'public-link-source-build',
      packageVersion: '0.1.4-cli.0', publicSourceRevision: 'a'.repeat(40), sourceDigest: `sha256:${'b'.repeat(64)}`,
      treeDigest: `sha256:${'c'.repeat(64)}`, packageArtifactId: `sha256:${'d'.repeat(64)}`, files: [] });
    for (const argv of [[], ['help'], ['--help'], ['-h']]) {
      await main(argv);
      const text = String(output.mock.lastCall?.[0]);
      expect(text).toContain('cekai-link setup');
      expect(text).toContain('cekai-link run');
      expect(text).toContain('cekai-link inspect [--json]');
      expect(text).toContain('显式绑定');
    }
    expect(verify).not.toHaveBeenCalled();
    vi.stubEnv('CEKAI_LINK_SOURCE_PACKAGE_ROOT', '/synthetic-package');
    for (const flag of ['--version', '-v']) {
      await main([flag]);
      expect(output.mock.lastCall?.[0]).toBe(`Cekai Link 0.1.4-cli.0\nsource ${'a'.repeat(40)}\n`);
    }
    expect(verify).toHaveBeenCalledWith('/synthetic-package');
    expect(store).not.toHaveBeenCalled(); expect(central).not.toHaveBeenCalled(); expect(serve).not.toHaveBeenCalled();
  });

  it('rejects unknown or duplicate flags without echoing their contents', () => {
    for (const name of ['inspect', 'status', 'doctor']) {
      expect(parsePublicLinkArgs([name])).toEqual({ command: 'inspect', json: false });
      expect(parsePublicLinkArgs([name, '--json'])).toEqual({ command: 'inspect', json: true });
    }
    for (const argv of [['inspect', '--synthetic-secret'], ['status', '--json', '--json'], ['doctor', '--write'],
      ['--help', 'run'], ['--version', '--json'], ['run', '--write']]) {
      expect(() => parsePublicLinkArgs(argv)).toThrow('cekai-link --help');
      expect(() => parsePublicLinkArgs(argv)).not.toThrow('synthetic-secret');
    }
  });
});
