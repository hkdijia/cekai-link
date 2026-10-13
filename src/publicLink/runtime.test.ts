import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createPublicLinkRuntime, type PublicLinkRuntimeStatus } from './runtime.js';
import type { PublicLinkApi } from './api.js';
import type { PublicLinkConfigStore } from './config.js';
import type { PublicCodexRuntime } from './codex.js';
import type { PublicLinkConfig, PublicLinkRuntimeTask } from './protocol.js';
import { SOURCE_PACKAGE_FILES, verifyPublicSourcePackage } from './packageIdentity.js';

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, rename: vi.fn(actual.rename) };
});
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const rootIdentity = `sha256:${'a'.repeat(64)}` as const;
const config: PublicLinkConfig = {
  version: 1, serverUrl: 'https://central.example.test', credential: 'credential', workerId: 'worker', deviceId: 'device', deviceName: 'Mac',
  workspace: { replicaId: 'replica', projectId: 'project', workspaceId: 'workspace', rootIdentity, rootDigest: 'root', canonicalRoot: '/tmp/workspace', os: 'macos', workspaceKind: 'git-root' }
};
const task: PublicLinkRuntimeTask = {
  taskId: 'task', executionId: 'execution', bindingRef: 'binding', environmentProfile: 'prod-readonly',
  requestDigest: `sha256:${'b'.repeat(64)}`, requestBytes: Uint8Array.from(Buffer.from('question')),
  target: { deviceId: 'device', workerId: 'worker', projectId: 'project', replicaId: 'replica', workspaceId: 'workspace', rootIdentity }, leaseExpiresAt: Date.now() + 60_000
};

async function fixture(overrides: Partial<PublicLinkApi> = {}, options: Partial<Parameters<typeof createPublicLinkRuntime>[0]> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'public-link-runtime-unit-')); roots.push(root);
  const claimedTask = { ...task, leaseExpiresAt: Date.now() + 60_000 };
  const api: PublicLinkApi = {
    pair: vi.fn(), register: vi.fn(async () => ({})), heartbeat: vi.fn(async () => undefined), readSnapshot: vi.fn(),
    registerWorkspace: vi.fn(), claim: vi.fn(async () => claimedTask), renew: vi.fn(async () => undefined), release: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined), fail: vi.fn(async () => undefined), ...overrides
  };
  const configStore: PublicLinkConfigStore = { filePath: path.join(root, 'config.json'), load: async () => config, save: vi.fn(async () => undefined) };
  const codex: PublicCodexRuntime = {
    start: vi.fn(async () => undefined), runTurn: vi.fn(async () => 'answer'),
    health: () => ({ state: 'ready', activeTurn: false }), close: vi.fn(async () => undefined)
  };
  const validateWorkspace = vi.fn(async () => ({ ...config.workspace!, workspaceId: config.workspace!.workspaceId as `workspace_${string}` }));
  const runtimePath = path.join(root, 'runtime.json');
  const runtime = createPublicLinkRuntime({ config: configStore, api, codex, validateWorkspace, runtimePath, ...options });
  return { api, codex, runtime, configStore, runtimePath, validateWorkspace, claimedTask };
}

async function verifiedPackageFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'public-link-health-package-')); roots.push(root);
  const hash = createHash('sha256');
  for (const file of SOURCE_PACKAGE_FILES) {
    const target = path.join(root, file); await mkdir(path.dirname(target), { recursive: true });
    const bytes = file === 'package.json' ? JSON.stringify({ name: '@cekaitech/cekai-link', version: '0.1.0',
      bin: { 'cekai-link': 'bin/cekai-link-source.cjs' }, cekaiLink: { packageFormat: 4 } }) : 'fixture\n';
    await writeFile(target, bytes); hash.update(file).update('\0').update(bytes).update('\0');
  }
  const descriptor = { schemaVersion: 1, packageVersion: '0.1.0', publicSourceRevision: 'a'.repeat(40), sourceDigest: rootIdentity,
    treeDigest: `sha256:${hash.digest('hex')}` };
  const packageArtifactId = `sha256:${createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')}` as const;
  await writeFile(path.join(root, 'link-build.json'), JSON.stringify({ ...descriptor, kind: 'public-link-source-build', packageArtifactId, files: SOURCE_PACKAGE_FILES }));
  expect(verifyPublicSourcePackage(root).packageArtifactId).toBe(packageArtifactId);
  vi.stubEnv('CEKAI_LINK_SOURCE_PACKAGE_ROOT', root);
  return { root, identity: { role: 'link' as const, publicPackageArtifactId: packageArtifactId, releaseId: rootIdentity, sourceRevision: 'a'.repeat(40),
    protocolVersion: 1, contractDigest: rootIdentity, roleDigest: rootIdentity, componentDigests: { mcp: rootIdentity, schemas: rootIdentity, skills: rootIdentity } } };
}

describe('public Link read-only runtime', () => {
  it('retains a startup failure for inspect and releases only its own runtime lock', async () => {
    const codex: PublicCodexRuntime = {
      start: async () => { throw new Error('Codex app-server could not start'); }, runTurn: vi.fn(),
      health: () => ({ state: 'failed', activeTurn: false }), close: vi.fn()
    };
    const { runtime, runtimePath, configStore, api } = await fixture({}, { codex });
    await expect(runtime.serve()).rejects.toThrow('Codex app-server could not start');
    expect(JSON.parse(await readFile(runtimePath, 'utf8'))).toMatchObject({ state: 'stopped', lastError: 'Codex app-server could not start' });
    await expect(readFile(`${configStore.filePath}.runtime.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(api.claim).not.toHaveBeenCalled(); expect(codex.close).toHaveBeenCalledOnce();
  });
  it('runs only a matching bound-workspace task and completes the exact answer bytes', async () => {
    const { api, codex, runtime, claimedTask } = await fixture();
    await expect(runtime.runOnce()).resolves.toBe('completed');
    expect(api.register).toHaveBeenCalledWith(config.serverUrl, config.credential, undefined, config.deviceName, config.workspace!.projectId,
      { artifactIntegrity: 'unverified', agentRuntime: { total: 0, active: 0, recoveryRequired: 0, resumable: 0 } });
    expect(codex.runTurn).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/tmp/workspace', request: 'question' }));
    expect(api.complete).toHaveBeenCalledWith(config.serverUrl, config.credential, claimedTask, Uint8Array.from(Buffer.from('answer')));
    expect(api.fail).not.toHaveBeenCalled();
  });

  it('preserves the registered project declaration across consecutive polling passes', async () => {
    const { api, runtime } = await fixture({ claim: vi.fn(async () => undefined) });
    await expect(runtime.runOnce()).resolves.toBe('no-task');
    await expect(runtime.runOnce()).resolves.toBe('no-task');
    expect(api.register).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(api.register).mock.calls) {
      expect(call).toEqual([config.serverUrl, config.credential, undefined, config.deviceName, config.workspace!.projectId,
        { artifactIntegrity: 'unverified', agentRuntime: { total: 0, active: 0, recoveryRequired: 0, resumable: 0 } }]);
    }
  });

  it('keeps a healthy idle runtime running while the next registration is pending', async () => {
    const published: PublicLinkRuntimeStatus[] = [];
    const registrationStates: string[] = [];
    const { runtime } = await fixture({
      claim: vi.fn(async () => undefined),
      register: vi.fn(async () => { registrationStates.push(published.at(-1)!.state); return {}; })
    }, { publishStatus: async value => { published.push(value); } });
    await runtime.runOnce();
    await runtime.runOnce();
    expect(registrationStates).toEqual(['starting', 'running']);
  });

  it('loads the persisted sequence before the first runOnce publication', async () => {
    const published: PublicLinkRuntimeStatus[] = [];
    const { api, runtime, runtimePath } = await fixture({ claim: vi.fn(async () => undefined) }, {
      publishStatus: async (value) => { published.push(value); }
    });
    await writeFile(runtimePath, JSON.stringify({ state: 'stopped', pid: process.pid, sequence: 41, updatedAt: new Date().toISOString() }));
    await expect(runtime.runOnce()).resolves.toBe('no-task');
    expect(published[0].sequence).toBe(41);
    expect(vi.mocked(api.heartbeat).mock.calls.map((call) => call[2].sequence)).toEqual([42, 43]);
  });

  it('preserves the previous sequence through a real serve startup and graceful stop', async () => {
    const controller = new AbortController();
    let beats = 0;
    const { api, runtime, runtimePath } = await fixture({
      claim: vi.fn(async () => undefined),
      heartbeat: vi.fn(async () => { if (++beats === 2) controller.abort(); })
    });
    await writeFile(runtimePath, JSON.stringify({ state: 'stopped', pid: process.pid, sequence: 50, updatedAt: new Date().toISOString() }));
    await runtime.serve(controller.signal);
    expect(vi.mocked(api.heartbeat).mock.calls.map((call) => call[2].sequence)).toEqual([51, 52]);
    expect(JSON.parse(await readFile(runtimePath, 'utf8'))).toMatchObject({ state: 'stopped', sequence: 52 });
  });

  it.each([[12, 9410, 9411], [70, 5, 71]])('continues after the greater local or authoritative sequence (%i, %i)', async (local, remote, next) => {
    const { api, runtime, runtimePath } = await fixture({
      register: vi.fn(async () => ({ heartbeatSequence: remote })), claim: vi.fn(async () => undefined)
    });
    await writeFile(runtimePath, JSON.stringify({ state: 'stopped', pid: process.pid, sequence: local, updatedAt: new Date().toISOString() }));
    await expect(runtime.runOnce()).resolves.toBe('no-task');
    expect(vi.mocked(api.heartbeat).mock.calls[0][2].sequence).toBe(next);
  });

  it('does not overwrite corrupt previous runtime evidence or silently reset its sequence', async () => {
    const { api, runtime, runtimePath } = await fixture();
    await writeFile(runtimePath, 'invalid previous status');
    await expect(runtime.runOnce()).rejects.toThrow('runtime status is invalid');
    expect(await readFile(runtimePath, 'utf8')).toBe('invalid previous status');
    expect(api.register).not.toHaveBeenCalled();
    expect(api.heartbeat).not.toHaveBeenCalled();
  });

  it('fails closed at sequence exhaustion rather than emitting an unsafe or reset heartbeat', async () => {
    const { api, runtime, runtimePath } = await fixture({ register: vi.fn(async () => ({ heartbeatSequence: Number.MAX_SAFE_INTEGER })) });
    await writeFile(runtimePath, JSON.stringify({ state: 'stopped', pid: process.pid, sequence: 0, updatedAt: new Date().toISOString() }));
    await expect(runtime.runOnce()).rejects.toThrow('sequence is exhausted');
    expect(api.heartbeat).not.toHaveBeenCalled();
    expect(api.claim).not.toHaveBeenCalled();
  });

  it('preserves an interrupted task as recovery-required and does not claim another task', async () => {
    const { api, codex, runtime, runtimePath } = await fixture({ register: vi.fn(async () => ({ heartbeatSequence: 99 })) });
    await writeFile(runtimePath, JSON.stringify({ state: 'busy', pid: process.pid, sequence: 40, currentTask: 'interrupted-task', updatedAt: new Date().toISOString() }));
    await expect(runtime.runOnce()).rejects.toThrow('recovery required');
    expect(api.heartbeat).toHaveBeenCalledWith(config.serverUrl, config.credential, expect.objectContaining({
      sequence: 100, currentTaskId: 'interrupted-task',
      runtimeHealth: { artifactIntegrity: 'unverified', agentRuntime: { total: 1, active: 0, recoveryRequired: 1, resumable: 0 } }
    }));
    expect(JSON.parse(await readFile(runtimePath, 'utf8')).currentTask).toBe('interrupted-task');
    expect(api.claim).not.toHaveBeenCalled();
    expect(codex.runTurn).not.toHaveBeenCalled();
  });

  it('does not clear task evidence when both completion and failure acknowledgment are unavailable', async () => {
    const { api, runtime, runtimePath } = await fixture({
      complete: vi.fn(async () => { throw new Error('completion unavailable'); }),
      fail: vi.fn(async () => { throw new Error('failure unavailable'); })
    });
    await expect(runtime.runOnce()).resolves.toBe('failed');
    expect(JSON.parse(await readFile(runtimePath, 'utf8'))).toMatchObject({ currentTask: 'task' });
    await expect(runtime.runOnce()).rejects.toThrow('recovery required');
    expect(api.claim).toHaveBeenCalledOnce();
    expect(vi.mocked(api.heartbeat).mock.calls.at(-1)![2].runtimeHealth?.agentRuntime)
      .toEqual({ total: 1, active: 0, recoveryRequired: 1, resumable: 0 });
  });

  it('reports verified idle health only after checking the actual package bytes and exact identity', async () => {
    const { root, identity } = await verifiedPackageFixture();
    const { api, runtime } = await fixture({ claim: vi.fn(async () => undefined) }, { identity });
    await expect(runtime.runOnce()).resolves.toBe('no-task');
    expect(api.heartbeat).toHaveBeenCalledWith(config.serverUrl, config.credential, expect.objectContaining({
      runtimeHealth: { artifactIntegrity: 'verified', agentRuntime: { total: 0, active: 0, recoveryRequired: 0, resumable: 0 } }
    }));
    const priorCalls = vi.mocked(api.register).mock.calls.length;
    await writeFile(path.join(root, 'dist/publicLink/api.js'), 'tampered');
    await expect(runtime.runOnce()).rejects.toThrow('integrity is invalid');
    expect(api.register).toHaveBeenCalledTimes(priorCalls);
  });

  it('does not report a different valid package as the admitted runtime identity', async () => {
    const { identity } = await verifiedPackageFixture();
    const { api, runtime } = await fixture({}, { identity: { ...identity, publicPackageArtifactId: `sha256:${'b'.repeat(64)}` } });
    await expect(runtime.runOnce()).rejects.toThrow('integrity is invalid');
    expect(api.register).not.toHaveBeenCalled();
    expect(api.claim).not.toHaveBeenCalled();
  });

  it('fails a mismatched Central target closed without invoking Codex', async () => {
    const { api, codex, runtime } = await fixture({ claim: vi.fn(async () => ({ ...task, target: { ...task.target, replicaId: 'other-replica' } })) });
    await expect(runtime.runOnce()).resolves.toBe('failed');
    expect(codex.runTurn).not.toHaveBeenCalled();
    expect(api.fail).toHaveBeenCalledWith(config.serverUrl, config.credential, expect.objectContaining({ taskId: 'task' }), 'runner-failed');
  });

  it('serializes overlapping lifecycle publications instead of losing a completed answer to concurrent rename failures', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let activeRenames = 0; let maximumRenames = 0;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      activeRenames += 1; maximumRenames = Math.max(maximumRenames, activeRenames);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (activeRenames > 1) throw Object.assign(new Error('concurrent replacement'), { code: 'EPERM' });
        await actual.rename(from, to);
      } finally { activeRenames -= 1; }
    });
    try {
      const { api, codex, runtime } = await fixture();
      vi.mocked(codex.runTurn).mockImplementation(async (input) => {
        await Promise.all(['turn-started', 'final-output', 'turn-completed'].map((event) => input.onLifecycle?.(event as 'turn-started' | 'final-output' | 'turn-completed')));
        return 'answer';
      });
      await expect(runtime.runOnce()).resolves.toBe('completed');
      expect(maximumRenames).toBe(1);
      expect(api.complete).toHaveBeenCalledOnce();
      expect(api.fail).not.toHaveBeenCalled();
    } finally { vi.mocked(rename).mockImplementation(actual.rename); }
  });

  it('passes bindingRef and revalidates the saved workspace before any Codex turn', async () => {
    const { codex, runtime, validateWorkspace } = await fixture();
    await runtime.runOnce();
    expect(validateWorkspace).toHaveBeenCalledWith(config.workspace!.canonicalRoot, 'macos');
    expect(codex.runTurn).toHaveBeenCalledWith(expect.objectContaining({ bindingRef: 'binding' }));
  });

  it('rejects workspace replacement without launching a turn', async () => {
    const { api, codex, runtime, validateWorkspace } = await fixture();
    validateWorkspace.mockResolvedValue({ ...config.workspace!, workspaceId: 'workspace_replaced' });
    await expect(runtime.runOnce()).resolves.toBe('failed');
    expect(codex.runTurn).not.toHaveBeenCalled();
    expect(api.complete).not.toHaveBeenCalled();
  });

  it('keeps active-task heartbeat fresh while renewing a long turn', async () => {
    const { api, codex, runtime, runtimePath } = await fixture({}, { maintenanceMs: 10 });
    let finish!: (answer: string) => void;
    vi.mocked(codex.runTurn).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = runtime.runOnce();
    try {
      await vi.waitFor(() => expect(vi.mocked(api.renew).mock.calls.length).toBeGreaterThanOrEqual(2), { interval: 5 });
      expect(api.heartbeat).toHaveBeenCalledWith(config.serverUrl, config.credential, expect.objectContaining({ currentTaskId: 'task' }));
      expect(api.heartbeat).toHaveBeenCalledWith(config.serverUrl, config.credential, expect.objectContaining({
        runtimeHealth: { artifactIntegrity: 'unverified', agentRuntime: { total: 1, active: 1, recoveryRequired: 0, resumable: 0 } }
      }));
      const local = JSON.parse(await readFile(runtimePath, 'utf8'));
      expect(local).toMatchObject({ state: 'busy', currentTask: 'task' });
      const sequences = vi.mocked(api.heartbeat).mock.calls.map((call) => call[2].sequence);
      expect(new Set(sequences).size).toBe(sequences.length);
      finish('answer');
      await expect(pending).resolves.toBe('completed');
    } finally { finish?.('answer'); await pending; }
  });

  it('interrupts execution and never completes after a renewal failure', async () => {
    const { api, codex, runtime } = await fixture({ renew: vi.fn(async () => { throw new Error('renewal rejected'); }) }, { maintenanceMs: 10 });
    vi.mocked(codex.runTurn).mockImplementation((input) => new Promise((_, reject) => {
      input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true });
    }));
    await expect(runtime.runOnce()).resolves.toBe('failed');
    expect(api.complete).not.toHaveBeenCalled();
    expect(api.fail).toHaveBeenCalledWith(config.serverUrl, config.credential, expect.anything(), 'lease-lost');
  });

  it('maintains liveness beyond the 90-second freshness window without requiring agent output', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const publications: PublicLinkRuntimeStatus[] = [];
    // Keep virtual scheduler assertions independent of OS file-I/O callbacks.
    // Real Windows rename/publication is covered by the separate native tests.
    const publishStatus = vi.fn(async (value: PublicLinkRuntimeStatus) => { publications.push(value); });
    const { api, codex, runtime } = await fixture({}, { leaseMs: 120_000, maintenanceMs: 30_000, publishStatus });
    let finish!: (answer: string) => void;
    vi.mocked(codex.runTurn).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = runtime.runOnce();
    try {
      await vi.waitFor(() => expect(codex.runTurn).toHaveBeenCalled());
      for (let step = 0; step < 4; step += 1) {
        const before = vi.mocked(api.heartbeat).mock.calls.at(-1)![2].sequence;
        await vi.advanceTimersByTimeAsync(30_000);
        const local = publications.at(-1)!;
        expect(local.sequence).toBeGreaterThan(before);
        expect(Date.now() - Date.parse(local.updatedAt)).toBeLessThan(90_000);
        expect(local).toMatchObject({ state: 'busy', currentTask: 'task' });
      }
      expect(vi.mocked(api.renew).mock.calls.length).toBeGreaterThanOrEqual(4);
      finish('answer'); await expect(pending).resolves.toBe('completed');
    } finally { finish?.('answer'); await pending; }
  });

  it('rejects an expired claim without invoking Codex', async () => {
    const { api, codex, runtime } = await fixture({ claim: vi.fn(async () => ({ ...task, leaseExpiresAt: Date.now() - 1 })) });
    await expect(runtime.runOnce()).resolves.toBe('failed');
    expect(codex.runTurn).not.toHaveBeenCalled();
    expect(api.fail).toHaveBeenCalledWith(config.serverUrl, config.credential, expect.anything(), 'lease-lost');
  });

  it('does not overwrite an existing runtime lock or publish state for an unknown owner', async () => {
    const { runtime, configStore, runtimePath } = await fixture();
    const lock = `${configStore.filePath}.runtime.lock`;
    await writeFile(lock, 'unknown-owner');
    await expect(runtime.runOnce()).rejects.toThrow('runtime lock exists');
    expect(await readFile(lock, 'utf8')).toBe('unknown-owner');
    await expect(readFile(runtimePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
