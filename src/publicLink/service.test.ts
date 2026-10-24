import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import * as fileSystem from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { operatePublicLinkService } from './service.js';
import { createPublicLinkConfigStore, replacePublicLinkFile } from './config.js';
import * as identity from './packageIdentity.js';
import { readServiceOwner, readServiceRecord, serviceOwnerPath, serviceRecordPath, withServiceLock, writeServiceJson, type PublicLinkServiceRecord } from './serviceFiles.js';
import type { PublicLinkNativeService } from '../adapters/publicLinkService/native.js';

const roots: string[] = [];
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'public-service-')); roots.push(root);
  const configPath = path.join(root, 'config.json'); const runtimePath = path.join(root, 'runtime.json');
  const packageRoot = path.join(root, 'package');
  await mkdir(path.join(packageRoot, 'bin'), { recursive: true }); await writeFile(path.join(packageRoot, 'bin/cekai-link-source.cjs'), 'fixture');
  await createPublicLinkConfigStore(configPath).save({ version: 1, serverUrl: 'http://127.0.0.1', credential: 'secret-fixture', workerId: 'worker', deviceId: 'device', deviceName: 'fixture', compatibilityPath: path.join(root, 'mapping.json'),
    workspace: { replicaId: 'replica', projectId: 'project', workspaceId: 'workspace', rootIdentity: `sha256:${'a'.repeat(64)}`, rootDigest: 'root', canonicalRoot: root, os: 'macos', workspaceKind: 'folder' } });
  vi.spyOn(identity, 'verifyPublicSourcePackage').mockReturnValue({ packageArtifactId: `sha256:${'a'.repeat(64)}` } as ReturnType<typeof identity.verifyPublicSourcePackage>);
  vi.spyOn(identity, 'readPublicSourceRuntimeIdentity').mockReturnValue({ publicPackageArtifactId: `sha256:${'a'.repeat(64)}` } as ReturnType<typeof identity.readPublicSourceRuntimeIdentity>);
  const manager: PublicLinkNativeService = { query: vi.fn(async () => 'absent'), install: vi.fn(async () => {}), start: vi.fn(async () => {}), stop: vi.fn(async () => {}), uninstall: vi.fn(async () => {}) };
  const input = { configPath, runtimePath, packageRoot, native: () => manager, waitMs: 1 };
  return { root, configPath, runtimePath, manager, input };
}

describe('public service lifecycle and owned files', () => {
  it('registers an explicitly disabled service without starting the runtime', async () => {
    const { configPath, manager, input } = await fixture();
    expect(await operatePublicLinkService('install', { ...input, enableOnInstall: false })).toMatchObject({ action: 'installed-disabled', enabled: false, process: 'stopped' });
    expect(manager.install).toHaveBeenCalledOnce(); expect(manager.start).not.toHaveBeenCalled();
    expect((await readServiceRecord(configPath))?.enabled).toBe(false);
  });
  it('retries transient Windows replace denial without deleting a valid target and preserves it after bounded failure', async () => {
    const { root } = await fixture();
    const source = path.join(root, 'prepared'); const target = path.join(root, 'current');
    await writeFile(source, 'new-complete'); await writeFile(target, 'previous-valid');
    const originalRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename;
    const denied = Object.assign(new Error('reader still holds file'), { code: 'EPERM' });
    const rename = vi.mocked(fileSystem.rename);
    rename.mockRejectedValueOnce(denied);
    await replacePublicLinkFile(source, target, 'win32');
    expect(await readFile(target, 'utf8')).toBe('new-complete');
    await writeFile(source, 'another-new'); rename.mockRejectedValue(denied);
    try {
      await expect(replacePublicLinkFile(source, target, 'win32')).rejects.toBe(denied);
      expect(await readFile(target, 'utf8')).toBe('new-complete');
      expect(await readFile(source, 'utf8')).toBe('another-new');
    } finally { rename.mockImplementation(originalRename); }
  });

  it('publishes a complete exclusive owner record without exposing partial bytes and keeps an existing owner intact', async () => {
    const { configPath } = await fixture();
    let writing!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { writing = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const originalOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
    vi.mocked(fileSystem.open).mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementation(async (...data) => { writing(); await gate; return write(...data); });
      return handle;
    });
    const owner = { pid: process.pid, token: 'a'.repeat(36) };
    const publish = writeServiceJson(serviceOwnerPath(configPath), owner, true);
    await entered;
    try { expect(await readServiceOwner(configPath)).toBeUndefined(); }
    finally { release(); await publish; vi.mocked(fileSystem.open).mockImplementation(originalOpen); }
    expect(await readServiceOwner(configPath)).toEqual(owner);
    await expect(writeServiceJson(serviceOwnerPath(configPath), { ...owner, token: 'b'.repeat(36) }, true)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readServiceOwner(configPath)).toEqual(owner);
  });

  it('waits for the new runtime identity and running state instead of accepting its lock or an older snapshot', async () => {
    const { configPath, runtimePath, manager, input } = await fixture();
    let runningPublished = false;
    vi.mocked(manager.start).mockImplementation(async () => {
      await writeServiceJson(serviceOwnerPath(configPath), { pid: process.pid, token: 'a'.repeat(36) });
      await writeFile(`${configPath}.runtime.lock`, JSON.stringify({ pid: process.pid, token: 'fixture' }));
      await writeFile(runtimePath, JSON.stringify({ state: 'running', pid: 2_147_483_647, sequence: 1, updatedAt: new Date().toISOString() }));
      setTimeout(() => { void writeFile(runtimePath, JSON.stringify({ state: 'running', pid: process.pid, sequence: 2, updatedAt: new Date().toISOString() })).then(() => { runningPublished = true; }); }, 20);
    });
    const result = await operatePublicLinkService('install', { ...input, waitMs: 1000 });
    expect(result).toMatchObject({ action: 'installed', process: 'running' });
    expect(runningPublished).toBe(true);
  });

  it('rejects a foreground lock or pending task before registering, without deleting evidence', async () => {
    const { configPath, runtimePath, manager, input } = await fixture();
    await writeFile(`${configPath}.runtime.lock`, 'foreground-owner');
    await expect(operatePublicLinkService('install', input)).rejects.toThrow('foreground');
    expect(await readFile(`${configPath}.runtime.lock`, 'utf8')).toBe('foreground-owner');
    await rm(`${configPath}.runtime.lock`);
    await writeFile(runtimePath, JSON.stringify({ state: 'stopped', pid: 1, sequence: 4, currentTask: 'uncertain-task', updatedAt: new Date().toISOString() }));
    await expect(operatePublicLinkService('install', input)).rejects.toThrow('recovery');
    expect(manager.start).not.toHaveBeenCalled(); expect(await readServiceRecord(configPath)).toBeUndefined();
  });

  it('retains an interrupted registration for an explicit idempotent retry and stores no credentials', async () => {
    const { configPath, manager, input } = await fixture();
    vi.mocked(manager.start).mockRejectedValueOnce(new Error('manager interrupted'));
    await expect(operatePublicLinkService('install', input)).rejects.toThrow('interrupted');
    const bytes = await readFile(serviceRecordPath(configPath), 'utf8');
    expect(bytes).not.toContain('secret-fixture'); expect(bytes).not.toContain('worker');
    vi.stubEnv('PATH', `${process.env.PATH}${path.delimiter}/different-terminal`);
    await expect(operatePublicLinkService('start', input)).rejects.toThrow('unconfirmed');
    expect(manager.start).toHaveBeenCalledTimes(2);
    expect(await readFile(serviceRecordPath(configPath), 'utf8')).toBe(bytes);
    await expect(readFile(`${serviceRecordPath(configPath)}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stop persists disabled intent; uninstall keeps pairing/config/runtime and never kills a foreground runtime', async () => {
    const { configPath, runtimePath, manager, input } = await fixture();
    await expect(operatePublicLinkService('install', input)).rejects.toThrow('unconfirmed');
    const originalConfig = await readFile(configPath);
    await writeFile(runtimePath, 'preserved-runtime'); await writeFile(`${configPath}.runtime.lock`, 'foreground-owner');
    await operatePublicLinkService('stop', input);
    expect((await readServiceRecord(configPath))?.enabled).toBe(false);
    await operatePublicLinkService('uninstall', input);
    expect(await readServiceRecord(configPath)).toBeUndefined(); expect(manager.uninstall).toHaveBeenCalledOnce();
    expect(await readFile(configPath)).toEqual(originalConfig); expect(await readFile(runtimePath, 'utf8')).toBe('preserved-runtime');
    expect(await readFile(`${configPath}.runtime.lock`, 'utf8')).toBe('foreground-owner');
  });

  it('does not mutate an occupied native name or a changed package registration', async () => {
    const { configPath, manager, input } = await fixture();
    vi.mocked(manager.query).mockResolvedValue('foreign');
    await expect(operatePublicLinkService('install', input)).rejects.toThrow('occupied');
    expect(await readServiceRecord(configPath)).toBeUndefined(); expect(manager.start).not.toHaveBeenCalled();
    vi.mocked(manager.query).mockResolvedValue('absent');
    await expect(operatePublicLinkService('install', input)).rejects.toThrow('unconfirmed');
    const record = (await readServiceRecord(configPath))!;
    await writeServiceJson(serviceRecordPath(configPath), { ...record, packageArtifactId: `sha256:${'b'.repeat(64)}` });
    await expect(operatePublicLinkService('start', input)).rejects.toThrow('another package');
    expect((await readServiceRecord(configPath))?.packageArtifactId).toBe(`sha256:${'b'.repeat(64)}`);
  });

  it('rejects corrupt/symlink records and serializes service mutations without removing foreign locks', async () => {
    const { root, configPath } = await fixture();
    await writeFile(serviceRecordPath(configPath), '{broken');
    await expect(readServiceRecord(configPath)).rejects.toThrow('invalid');
    await rm(serviceRecordPath(configPath));
    const target = path.join(root, 'foreign'); await writeFile(target, '{}');
    // File symlinks require a privilege on Windows; directory/reparse defenses are native-contract covered.
    if (process.platform !== 'win32') {
      await symlink(target, serviceRecordPath(configPath)); await expect(readServiceRecord(configPath)).rejects.toThrow('invalid');
      await rm(serviceRecordPath(configPath));
    }
    await withServiceLock(configPath, async () => {
      await expect(withServiceLock(configPath, async () => {})).rejects.toThrow('service lock');
    });
    const invalid: PublicLinkServiceRecord = { version: 1, configPath, runtimePath: path.join(root, 'runtime'), nodePath: process.execPath,
      entryPath: path.join(root, 'entry'), packageArtifactId: `sha256:${'a'.repeat(64)}`, home: homedir(), searchPath: 'path\nsecret', enabled: true };
    await writeServiceJson(serviceRecordPath(configPath), invalid);
    await expect(readServiceRecord(configPath)).rejects.toThrow('invalid');
  });
});
