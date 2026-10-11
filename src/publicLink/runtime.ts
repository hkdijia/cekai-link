import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPublicLinkApi, type PublicLinkApi } from './api.js';
import { createPublicLinkConfigStore, defaultPublicLinkRuntimePath, type PublicLinkConfigStore } from './config.js';
import { createPublicCodexRuntime, type PublicCodexRuntime } from './codex.js';
import { readPublicSourceRuntimeIdentity } from './packageIdentity.js';
import { validatePublicLinkWorkspace } from './workspace.js';
import {
  objectValue,
  type PublicLinkConfig,
  type PublicLinkDigest,
  type PublicLinkFailureReason,
  type PublicLinkRuntimeIdentity,
  type PublicLinkRuntimeTask
} from './protocol.js';

export interface PublicLinkRuntimeStatus {
  readonly state: 'stopped' | 'starting' | 'running' | 'busy' | 'failed';
  readonly pid: number;
  readonly sequence: number;
  readonly currentTask?: string;
  readonly lastError?: string;
  readonly updatedAt: string;
}

export interface PublicLinkRuntime {
  runOnce(signal?: AbortSignal): Promise<'no-task' | 'completed' | 'failed'>;
  serve(signal?: AbortSignal): Promise<void>;
  status(): PublicLinkRuntimeStatus;
  stop(): Promise<void>;
}

export function createPublicLinkRuntime(input: {
  readonly config?: PublicLinkConfigStore;
  readonly api?: PublicLinkApi;
  readonly codex?: PublicCodexRuntime;
  readonly runtimePath?: string;
  readonly pollMs?: number;
  readonly leaseMs?: number;
  readonly turnTimeoutMs?: number;
  readonly identity?: PublicLinkRuntimeIdentity;
  readonly validateWorkspace?: typeof validatePublicLinkWorkspace;
  readonly maintenanceMs?: number;
  readonly publishStatus?: (value: PublicLinkRuntimeStatus) => Promise<void>;
} = {}): PublicLinkRuntime {
  const configStore = input.config ?? createPublicLinkConfigStore();
  const shutdown = new AbortController();
  const api = input.api ?? createPublicLinkApi(fetch, { signal: shutdown.signal });
  const codex = input.codex ?? createPublicCodexRuntime();
  const runtimePath = path.resolve(input.runtimePath ?? defaultPublicLinkRuntimePath());
  const pollMs = bounded(input.pollMs ?? 2_000, 250, 60_000);
  const leaseMs = bounded(input.leaseMs ?? 120_000, 30_000, 600_000);
  const turnTimeoutMs = bounded(input.turnTimeoutMs ?? 15 * 60_000, 30_000, 60 * 60_000);
  const maintenanceMs = bounded(input.maintenanceMs ?? Math.min(30_000, Math.floor(leaseMs / 3)), 1, Math.floor(leaseMs / 3));
  const validateWorkspace = input.validateWorkspace ?? validatePublicLinkWorkspace;
  let state: PublicLinkRuntimeStatus['state'] = 'stopped';
  let sequence = 0;
  let currentTask: string | undefined;
  let lastError: string | undefined;
  let stopped = false;
  let sequenceLoaded = false;
  let pendingPublish: Promise<void> = Promise.resolve();
  let owning = false;

  const withOwnership = async <T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted();
    if (owning) throw new Error('This Link configuration already has an active runtime');
    owning = true;
    const lockPath = `${configStore.filePath}.runtime.lock`;
    const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
    let acquired = false;
    const stop = () => shutdown.abort(new Error('Link runtime stopped'));
    try {
      await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
      const handle = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('Link runtime lock exists; inspect the owning process before recovering a stale lock'); });
      acquired = true;
      try { await handle.writeFile(owner); }
      finally { await handle.close(); }
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
      shutdown.signal.throwIfAborted();
      return await action();
    } finally {
      signal?.removeEventListener('abort', stop);
      try {
        if (acquired && await readFile(lockPath, 'utf8').catch(() => '') === owner) await rm(lockPath, { force: true });
      } finally { owning = false; }
    }
  };

  const loadSequence = async (): Promise<void> => {
    if (sequenceLoaded) return;
    sequenceLoaded = true;
    const previous = await readPublicLinkRuntimeStatus(runtimePath).catch(() => undefined);
    if (previous) sequence = previous.sequence;
  };

  const publish = (): Promise<void> => {
    const value: PublicLinkRuntimeStatus = {
      state, pid: process.pid, sequence, ...(currentTask ? { currentTask } : {}), ...(lastError ? { lastError } : {}), updatedAt: new Date().toISOString()
    };
    // Lifecycle callbacks can arrive in the same pipe chunk. Preserve snapshot
    // order and allow only one replacement at a time (Windows rename semantics).
    const publication = pendingPublish.then(async () => {
      if (input.publishStatus) { await input.publishStatus(value); return; }
      await mkdir(path.dirname(runtimePath), { recursive: true, mode: 0o700 });
      const temporary = `${runtimePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      try { await rename(temporary, runtimePath); } catch (error) { await rm(temporary, { force: true }); throw error; }
    });
    // A failed write still rejects its caller, without poisoning later recovery.
    pendingPublish = publication.catch(() => undefined);
    return publication;
  };

  const loadConfig = async (): Promise<PublicLinkConfig> => {
    const config = await configStore.load();
    if (!config) throw new Error('Cekai Link is not paired; run setup first');
    if (!config.workspace) throw new Error('Cekai Link has no registered workspace; run setup first');
    return config;
  };

  const heartbeat = async (config: PublicLinkConfig): Promise<void> => {
    await loadSequence();
    sequence += 1;
    await api.heartbeat(config.serverUrl, config.credential, { sequence, ...(currentTask ? { currentTaskId: currentTask } : {}), ...(input.identity ? { identity: input.identity } : {}) });
  };

  const runOnce = async (signal?: AbortSignal): Promise<'no-task' | 'completed' | 'failed'> => {
    const config = await loadConfig();
    const workspace = config.workspace;
    if (!workspace) throw new Error('Cekai Link has no registered workspace; run setup first');
    signal?.throwIfAborted();
    state = 'starting'; lastError = undefined; await publish();
    await api.register(config.serverUrl, config.credential, input.identity, config.deviceName, workspace.projectId);
    await heartbeat(config);
    state = 'running'; await publish();
    const task = await api.claim(config.serverUrl, config.credential, leaseMs);
    if (!task) { await heartbeat(config); return 'no-task'; }
    currentTask = task.taskId; state = 'busy';
    const taskController = new AbortController();
    const cancel = () => taskController.abort(shutdown.signal.reason);
    shutdown.signal.addEventListener('abort', cancel, { once: true });
    if (shutdown.signal.aborted) cancel();
    let renewal: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let maintenance: Promise<void> = Promise.resolve();
    let maintaining = true;
    const leaseLost = () => taskController.abort(new Error('Link task lease lost'));
    const armExpiry = (expiresAt: number) => {
      if (expiry) clearTimeout(expiry);
      expiry = setTimeout(leaseLost, Math.max(0, expiresAt - Date.now()));
    };
    const schedule = () => {
      renewal = setTimeout(() => {
        maintenance = (async () => {
          taskController.signal.throwIfAborted();
          const renewalStartedAt = Date.now();
          await api.renew(config.serverUrl, config.credential, task.taskId, leaseMs);
          taskController.signal.throwIfAborted();
          // A delayed acknowledgment must not extend our local deadline beyond
          // the server's request-time lease extension.
          armExpiry(renewalStartedAt + leaseMs);
          await heartbeat(config);
          await publish();
        })().catch(leaseLost).finally(() => { if (maintaining && !taskController.signal.aborted) schedule(); });
      }, maintenanceMs);
    };
    const stopMaintenance = async () => {
      maintaining = false;
      if (renewal) clearTimeout(renewal);
      await maintenance;
      if (expiry) clearTimeout(expiry);
    };
    try {
      await publish();
      await heartbeat(config);
      assertTarget(config, task);
      const observed = await validateWorkspace(workspace.canonicalRoot, workspace.os);
      if (observed.canonicalRoot !== workspace.canonicalRoot || observed.workspaceId !== workspace.workspaceId
        || observed.rootIdentity !== workspace.rootIdentity || observed.workspaceKind !== workspace.workspaceKind) throw new Error('Registered workspace identity has changed; run setup with an explicitly registered workspace');
      if (task.leaseExpiresAt <= Date.now()) throw new Error('Link task lease lost');
      armExpiry(task.leaseExpiresAt); schedule();
      const answer = await codex.runTurn({
        workspaceKey: workspace.workspaceId, bindingRef: task.bindingRef, cwd: workspace.canonicalRoot,
        request: new TextDecoder('utf-8', { fatal: true }).decode(task.requestBytes), timeoutMs: turnTimeoutMs, signal: taskController.signal,
        onLifecycle: async () => { await publish(); }
      });
      await stopMaintenance();
      taskController.signal.throwIfAborted();
      const answerBytes = Uint8Array.from(Buffer.from(answer, 'utf8'));
      await api.complete(config.serverUrl, config.credential, task, answerBytes);
      state = 'running';
      return 'completed';
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'public Link task failed';
      const reason = failureReason(error);
      await api.fail(config.serverUrl, config.credential, task, reason).catch(() => undefined);
      state = 'failed'; await publish();
      return 'failed';
    } finally {
      await stopMaintenance();
      shutdown.signal.removeEventListener('abort', cancel);
      currentTask = undefined;
      await heartbeat(config).catch(() => undefined);
      await publish().catch(() => undefined);
    }
  };

  return {
    async runOnce(signal) { return withOwnership(() => runOnce(shutdown.signal), signal); },
    async serve(signal) {
      return withOwnership(async () => {
        stopped = false; state = 'starting'; await publish();
        try {
          await loadConfig();
          await codex.start();
          while (!shutdown.signal.aborted && !stopped) {
            const outcome = await runOnce(shutdown.signal).catch(async (error) => {
              lastError = error instanceof Error ? error.message : 'public Link loop failed'; state = 'failed'; await publish(); return 'failed' as const;
            });
            if (outcome === 'no-task' || outcome === 'failed') {
              try { await delay(pollMs, shutdown.signal); }
              catch (error) { if (!shutdown.signal.aborted) throw error; }
            }
          }
        } finally {
          state = 'stopped'; currentTask = undefined;
          try { await publish(); } finally { await codex.close(); }
        }
      }, signal);
    },
    status() { return { state, pid: process.pid, sequence, ...(currentTask ? { currentTask } : {}), ...(lastError ? { lastError } : {}), updatedAt: new Date().toISOString() }; },
    async stop() { if (owning) { stopped = true; shutdown.abort(new Error('Link runtime stopped')); } await codex.close(); }
  };
}

export async function readPublicLinkRuntimeStatus(filePath = defaultPublicLinkRuntimePath()): Promise<PublicLinkRuntimeStatus | undefined> {
  try {
    const value = objectValue(JSON.parse(await readFile(filePath, 'utf8')), 'runtime status');
    const state = value.state;
    if (!['stopped', 'starting', 'running', 'busy', 'failed'].includes(String(state))) throw new Error();
    if (!Number.isInteger(value.pid) || Number(value.pid) <= 0 || !Number.isInteger(value.sequence) || Number(value.sequence) < 0) throw new Error();
    if (typeof value.updatedAt !== 'string') throw new Error();
    return {
      state: state as PublicLinkRuntimeStatus['state'], pid: Number(value.pid), sequence: Number(value.sequence),
      ...(typeof value.currentTask === 'string' ? { currentTask: value.currentTask } : {}),
      ...(typeof value.lastError === 'string' ? { lastError: value.lastError } : {}), updatedAt: value.updatedAt
    };
  } catch (error) {
    if (isCode(error, 'ENOENT')) return undefined;
    throw new Error('Public Link runtime status is invalid');
  }
}

export function readPublicLinkRuntimeIdentity(artifactRoot = process.env.CEKAI_LINK_ARTIFACT_ROOT): PublicLinkRuntimeIdentity | undefined {
  if (process.env.CEKAI_LINK_SOURCE_PACKAGE_ROOT) return readPublicSourceRuntimeIdentity(process.env.CEKAI_LINK_SOURCE_PACKAGE_ROOT);
  if (!artifactRoot) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(`${artifactRoot}/artifact-manifest.json`, 'utf8')) as Record<string, unknown>;
    const releaseId = digest(manifest.releaseId);
    const contractDigest = digest(manifest.contractDigest);
    const roleDigest = digest(manifest.sourceLinkRoleDigest);
    const sourceRevision = typeof manifest.revision === 'string' ? manifest.revision : undefined;
    const protocolVersion = Number(manifest.protocolVersion);
    const artifactId = digest(manifest.artifactId);
    if (!sourceRevision || !Number.isInteger(protocolVersion) || !releaseId || !contractDigest || !roleDigest || !artifactId) return undefined;
    const release = objectValue(JSON.parse(readFileSync(path.join(artifactRoot, 'dist/release-manifest.json'), 'utf8')), 'legacy compatibility');
    const link = objectValue(objectValue(release.artifacts, 'legacy artifacts').link, 'legacy link');
    const components = objectValue(link.components, 'legacy components');
    const mcp = digest(components.mcp); const schemas = digest(components.schemas); const skills = digest(components.skills);
    if (release.releaseId !== releaseId || release.sourceRevision !== sourceRevision || link.digest !== roleDigest || !mcp || !schemas || !skills) return undefined;
    return { role: 'link', publicPackageArtifactId: artifactId, releaseId, sourceRevision, protocolVersion, contractDigest, roleDigest,
      componentDigests: { mcp, schemas, skills } };
  } catch { return undefined; }
}

function assertTarget(config: PublicLinkConfig, task: PublicLinkRuntimeTask): void {
  const workspace = config.workspace;
  if (!workspace || task.target.workerId !== config.workerId || task.target.deviceId !== config.deviceId
    || task.target.projectId !== workspace.projectId || task.target.replicaId !== workspace.replicaId
    || task.target.workspaceId !== workspace.workspaceId || task.target.rootIdentity !== workspace.rootIdentity) {
    throw new Error('Central task target does not match this registered Link workspace');
  }
}

function failureReason(error: unknown): PublicLinkFailureReason {
  const message = error instanceof Error ? error.message : '';
  if (/lease lost/i.test(message)) return 'lease-lost';
  if (/idle/i.test(message)) return 'codex-idle-timeout';
  if (/maximum duration/i.test(message)) return 'codex-maximum-duration-timeout';
  if (/completion/i.test(message)) return 'completion-failed';
  return 'runner-failed';
}

function digest(value: unknown): PublicLinkDigest | undefined { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) ? value as PublicLinkDigest : undefined; }
function bounded(value: number, minimum: number, maximum: number): number { return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : minimum; }
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('public Link stopped')); return; }
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onAbort = () => finish(() => reject(signal?.reason ?? new Error('public Link stopped')));
    const timer = setTimeout(() => finish(resolve), ms);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
function isCode(error: unknown, code: string): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === code; }
