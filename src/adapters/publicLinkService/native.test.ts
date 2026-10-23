import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicLinkNativeService, renderPublicLinkService, type ServiceExecute } from './native.js';
import { publicLinkServiceId, type PublicLinkServiceRecord } from '../../publicLink/serviceFiles.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const record = (home: string): PublicLinkServiceRecord => ({ version: 1, configPath: path.join(home, 'config.json'), runtimePath: path.join(home, 'runtime.json'),
  nodePath: '/usr/local/bin/node', entryPath: '/user/app & $value/bin/link.cjs', packageArtifactId: `sha256:${'a'.repeat(64)}`, home, searchPath: '/usr/local/bin:/usr/bin', enabled: true });
const scratch = async () => { const root = await mkdtemp(path.join(tmpdir(), 'public-service-native-')); roots.push(root); return root; };

describe('public user service adapters', () => {
  it('uses separate per-config identities and user-session definitions without credentials, restart loops or raw logs', () => {
    const value = record('/user/home');
    expect(publicLinkServiceId(value.configPath)).not.toBe(publicLinkServiceId('/user/other/config.json'));
    const mac = renderPublicLinkService(value, 'darwin');
    expect(mac).toContain('app &amp; $value'); expect(mac).toContain('<key>RunAtLoad</key><true/>');
    expect(mac).toContain('<key>KeepAlive</key><false/>');
    const linux = renderPublicLinkService(value, 'linux');
    expect(linux).toContain('Restart=no'); expect(linux).toContain('$$value'); expect(linux).toContain('StandardError=null');
    for (const definition of [mac, linux]) for (const forbidden of ['credential', 'Restart=always', 'SuccessfulExit', 'StandardOutPath']) expect(definition).not.toContain(forbidden);
  });

  it('does not register, stop or remove a foreign Mac definition', async () => {
    const value = record(await scratch());
    const file = path.join(value.home, 'Library', 'LaunchAgents', `${publicLinkServiceId(value.configPath)}.plist`);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'foreign user job');
    const execute = vi.fn<ServiceExecute>();
    const manager = createPublicLinkNativeService(value, { platform: 'darwin', uid: 501, execute });
    expect(await manager.query()).toBe('foreign');
    for (const action of [manager.start, manager.stop, manager.uninstall]) await expect(action()).rejects.toThrow('ownership');
    expect(execute).not.toHaveBeenCalled(); expect(await readFile(file, 'utf8')).toBe('foreign user job');
  });

  it('fails before writing a Linux definition when the user manager is unavailable', async () => {
    const value = record(await scratch());
    const manager = createPublicLinkNativeService(value, { platform: 'linux', execute: vi.fn(async () => { throw new Error('no user bus'); }) });
    expect(await manager.query()).toBe('unknown');
    await expect(manager.install()).rejects.toThrow('unavailable');
    await expect(readFile(path.join(value.home, '.config/systemd/user', `${publicLinkServiceId(value.configPath)}.service`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('proves Windows action, current-user principal and logon trigger before a destructive operation', async () => {
    const value = record(await scratch()); const scripts: string[] = [];
    const execute = vi.fn<ServiceExecute>(async (_file, args, env) => {
      const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le'); scripts.push(script);
      expect(env?.CEKAI_PUBLIC_SERVICE_ARGS).toContain('"service" "host" "--config"');
      return { stdout: 'foreign\n', stderr: '' };
    });
    const manager = createPublicLinkNativeService(value, { platform: 'win32', execute });
    await expect(manager.uninstall()).rejects.toThrow('ownership');
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('MSFT_TaskLogonTrigger'); expect(scripts[0]).toContain('SecurityIdentifier');
    expect(scripts[0]).not.toContain('Unregister-ScheduledTask');
  });

  it('uses current-user, no-password Windows registration and preserves path arguments literally', async () => {
    const value = { ...record(await scratch()), entryPath: 'C:\\My Apps\\link\\bin\\cekai-link-source.cjs' };
    const scripts: string[] = [];
    const execute = vi.fn<ServiceExecute>(async (_file, args, env) => {
      scripts.push(Buffer.from(args.at(-1)!, 'base64').toString('utf16le'));
      expect(env?.CEKAI_PUBLIC_SERVICE_ARGS).toContain('"C:\\My Apps\\link\\bin\\cekai-link-source.cjs"');
      return { stdout: scripts.length === 1 ? 'absent\n' : '', stderr: '' };
    });
    await createPublicLinkNativeService(value, { platform: 'win32', execute }).install();
    expect(scripts[1]).toContain('-LogonType Interactive -RunLevel Limited');
    expect(scripts[1]).toContain('-AtLogOn -User $identity');
    expect(scripts[1]).not.toContain('-Password'); expect(scripts[1]).not.toContain('-Force');
  });
});
