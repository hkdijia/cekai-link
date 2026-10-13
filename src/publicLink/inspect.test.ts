import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readPublicLinkSnapshot } from './inspect.js';
import { createPublicLinkConfigStore, defaultPublicLinkConfigPath, defaultPublicLinkRuntimePath } from './config.js';
import { createPublicLinkApi } from './api.js';
import type { PublicLinkCentralSnapshot } from './protocol.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('public Link inspect', () => {
  it('reports setup-required without contacting Central on a clean home', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cekai-public-inspect-'));
    roots.push(root);
    const configPath = path.join(root, 'config.json');
    await writeFile(path.join(root, 'unused'), 'fixture');
    const snapshot = await readPublicLinkSnapshot({ configPath, runtimePath: path.join(root, 'runtime.json') });
    expect(snapshot.overall).toBe('setup-required');
    expect(snapshot.setup.pairing).toBe('required');
    expect(snapshot.nextAction.code).toBe('pair-device');
  });

  it('uses a separate default namespace from the private/official Link', () => {
    expect(defaultPublicLinkConfigPath()).toContain('cekai-link-public');
    expect(defaultPublicLinkRuntimePath()).toContain('cekai-link-public');
  });

  it('does not declare ready from stale, invalid/future or dead-process runtime state', async () => {
    vi.stubEnv('CEKAI_LINK_SOURCE_PACKAGE_ROOT', '');
    const root = await mkdtemp(path.join(tmpdir(), 'cekai-inspect-stale-')); roots.push(root);
    const configPath = path.join(root, 'config.json'); const runtimePath = path.join(root, 'runtime.json');
    await createPublicLinkConfigStore(configPath).save({ version: 1, serverUrl: 'http://127.0.0.1', credential: 'fixture', workerId: 'worker', deviceId: 'device', deviceName: 'fixture',
      workspace: { replicaId: 'replica', projectId: 'project', workspaceId: 'workspace', rootIdentity: `sha256:${'a'.repeat(64)}`, rootDigest: 'root', canonicalRoot: '/fixture', os: 'macos', workspaceKind: 'folder' } });
    await mkdir(path.join(root, 'dist'));
    const files = ['dist/entry.js', 'dist/release-manifest.json'];
    const releaseId = `sha256:${'b'.repeat(64)}`; const revision = 'fixture-revision';
    const bytes = ['fixture', JSON.stringify({ releaseId, sourceRevision: revision })];
    const hash = (indexes: number[]) => {
      const result = createHash('sha256');
      for (const index of indexes) result.update(files[index]!).update('\0').update(bytes[index]!).update('\0');
      return `sha256:${result.digest('hex')}`;
    };
    await Promise.all(files.map((file, index) => writeFile(path.join(root, file), bytes[index]!)));
    const treeDigest = hash([0, 1]);
    await writeFile(path.join(root, 'artifact-manifest.json'), JSON.stringify({ releaseId, revision, files, entryRelativePath: files[0], entryDigest: hash([0]), treeDigest,
      artifactId: `sha256:${createHash('sha256').update(revision).update('\0').update(treeDigest).digest('hex')}` }));
    const api = { ...createPublicLinkApi(), readSnapshot: vi.fn(async (): Promise<PublicLinkCentralSnapshot> => ({ schemaVersion: 1, conversationBinding: 'active', activeBindingCount: 1, registeredProjectCount: 1, centralCompatibility: 'accepted', dispatchReady: true })) };
    const read = () => readPublicLinkSnapshot({ configPath, runtimePath, artifactRoot: root, api });
    const publish = (pid: number, updatedAt: string) => writeFile(runtimePath, JSON.stringify({ state: 'running', sequence: 1, pid, updatedAt }));
    await publish(process.pid, new Date().toISOString());
    expect((await read()).overall).toBe('ready');
    await writeFile(runtimePath, JSON.stringify({ state: 'starting', sequence: 1, pid: process.pid, updatedAt: new Date().toISOString() }));
    expect((await read()).overall).toBe('degraded');
    for (const updatedAt of [new Date(Date.now() - 100_000).toISOString(), 'invalid-date', new Date(Date.now() + 60_000).toISOString()]) {
      await publish(process.pid, updatedAt);
      expect((await read()).overall).toBe('degraded');
    }
    await publish(2_147_483_647, new Date().toISOString());
    expect((await read()).overall).toBe('offline');
    api.readSnapshot.mockResolvedValueOnce({ schemaVersion: 1, conversationBinding: 'active', activeBindingCount: 1,
      registeredProjectCount: 1, centralCompatibility: 'incompatible', dispatchReady: false });
    expect((await read()).nextAction.code).toBe('diagnose-central');
    api.readSnapshot.mockRejectedValueOnce(new Error('credential=synthetic-secret'));
    await publish(process.pid, new Date().toISOString());
    const unavailable = await read();
    expect(unavailable).toMatchObject({ overall: 'degraded', sources: { central: 'unavailable' }, nextAction: { code: 'retry-central-inspection' } });
    expect(JSON.stringify(unavailable)).not.toContain('synthetic-secret');
    await writeFile(runtimePath, JSON.stringify({ state: 'stopped', sequence: 1, pid: 2_147_483_647,
      currentTask: 'private-interrupted-task', updatedAt: new Date().toISOString() }));
    const recovery = await read();
    expect(recovery.nextAction.code).toBe('resolve-recovery');
    expect(JSON.stringify(recovery)).not.toContain('private-interrupted-task');
    await writeFile(runtimePath, 'corrupt-runtime-synthetic-secret');
    const invalidRuntime = await read();
    expect(invalidRuntime).toMatchObject({ overall: 'unavailable', nextAction: { code: 'repair-local-configuration' } });
    expect(JSON.stringify(invalidRuntime)).not.toContain('corrupt-runtime-synthetic-secret');
  });
});
