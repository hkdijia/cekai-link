import {
  assertIdentifier,
  decodeBytes,
  digestBytes,
  encodeBytes,
  httpsServerUrl,
  objectValue,
  parseCentralSnapshot,
  type PublicLinkCentralSnapshot,
  type PublicLinkConfig,
  type PublicLinkDigest,
  type PublicLinkFailureReason,
  type PublicLinkRuntimeIdentity,
  type PublicLinkRuntimeHealth,
  type PublicLinkRuntimeTask,
  type PublicLinkWorkspace
} from './protocol.js';

export interface PublicLinkApi {
  pair(serverUrl: string, code: string, deviceName: string, identity?: PublicLinkRuntimeIdentity): Promise<Pick<PublicLinkConfig, 'credential' | 'workerId' | 'deviceId'>>;
  register(serverUrl: string, credential: string, identity?: PublicLinkRuntimeIdentity, deviceName?: string, projectId?: string, runtimeHealth?: PublicLinkRuntimeHealth): Promise<{ readonly heartbeatSequence?: number }>;
  heartbeat(serverUrl: string, credential: string, input: { sequence: number; currentTaskId?: string; identity?: PublicLinkRuntimeIdentity; runtimeHealth?: PublicLinkRuntimeHealth }): Promise<void>;
  readSnapshot(serverUrl: string, credential: string): Promise<PublicLinkCentralSnapshot>;
  registerWorkspace(serverUrl: string, credential: string, workspace: Omit<PublicLinkWorkspace, 'replicaId' | 'projectId'>, project?: { projectId: string } | { projectKey: string }): Promise<Pick<PublicLinkWorkspace, 'replicaId' | 'projectId'>>;
  claim(serverUrl: string, credential: string, leaseMs: number): Promise<PublicLinkRuntimeTask | undefined>;
  renew(serverUrl: string, credential: string, taskId: string, leaseMs: number): Promise<void>;
  release(serverUrl: string, credential: string, taskId: string): Promise<void>;
  complete(serverUrl: string, credential: string, task: PublicLinkRuntimeTask, answer: Uint8Array): Promise<void>;
  fail(serverUrl: string, credential: string, task: PublicLinkRuntimeTask, reason: PublicLinkFailureReason): Promise<void>;
}

export function createPublicLinkApi(fetchPort: typeof fetch = fetch, options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}): PublicLinkApi {
  const post = (server: string, endpoint: string, credential: string | undefined, body: unknown) => request(fetchPort, server, endpoint, 'POST', credential, body, options);
  const get = (server: string, endpoint: string, credential: string) => request(fetchPort, server, endpoint, 'GET', credential, undefined, options);
  return {
    async pair(serverUrl, code, deviceName, identity) {
      requirePublicIdentity(serverUrl, identity);
      const response = objectValue(await post(serverUrl, '/api/worker/pair', undefined, {
        code: assertIdentifier(code, 'pairing code'), name: assertIdentifier(deviceName, 'device name'), projects: [], capabilities: ['read-only'],
        ...(identity ? { runtime: identity } : {})
      }), 'pair response');
      if (response.ok !== true) throw new Error('Central rejected device pairing');
      const worker = objectValue(response.worker, 'pair worker');
      return { credential: assertIdentifier(response.credential, 'credential'), workerId: assertIdentifier(worker.workerId, 'workerId'), deviceId: assertIdentifier(worker.deviceId, 'deviceId') };
    },
    async register(serverUrl, credential, identity, deviceName = 'Cekai Link', projectId, runtimeHealth) {
      requirePublicIdentity(serverUrl, identity);
      const response = objectValue(await post(serverUrl, '/api/worker/register', credential, {
        name: assertIdentifier(deviceName, 'device name'), projects: projectId === undefined ? [] : [assertIdentifier(projectId, 'projectId')],
        capabilities: ['read-only'], ...(identity ? { runtime: identity } : {}), ...(runtimeHealth ? { runtimeHealth } : {})
      }), 'register response');
      if (response.ok !== true) throw new Error('Central rejected Link registration');
      const device = response.device === undefined ? undefined : objectValue(response.device, 'registered device');
      if (device?.heartbeatSequence === undefined) return {};
      if (!Number.isSafeInteger(device.heartbeatSequence) || Number(device.heartbeatSequence) < 0) throw new Error('Registered heartbeat sequence is invalid');
      return { heartbeatSequence: Number(device.heartbeatSequence) };
    },
    async heartbeat(serverUrl, credential, input) {
      requirePublicIdentity(serverUrl, input.identity);
      const response = objectValue(await post(serverUrl, '/api/worker/heartbeat', credential, {
        sequence: input.sequence, sentAt: Date.now(), ...(input.currentTaskId ? { currentTaskId: input.currentTaskId } : {}), ...(input.identity ? { runtime: input.identity } : {}),
        ...(input.runtimeHealth ? { runtimeHealth: input.runtimeHealth } : {})
      }), 'heartbeat response');
      if (response.ok !== true) throw new Error('Central rejected Link heartbeat');
    },
    async readSnapshot(serverUrl, credential) {
      return parseCentralSnapshot(await get(serverUrl, '/api/worker/operations-snapshot', credential));
    },
    async registerWorkspace(serverUrl, credential, workspace, project) {
      const response = objectValue(await post(serverUrl, '/api/worker/project-replicas', credential, {
        ...(project ? { project } : {}), workspaceId: workspace.workspaceId, rootIdentity: workspace.rootIdentity,
        os: workspace.os, workspaceKind: workspace.workspaceKind
      }), 'workspace registration response');
      if (response.ok !== true) throw new Error('Central rejected workspace registration');
      const replica = objectValue(response.replica, 'workspace replica');
      return { replicaId: assertIdentifier(replica.replicaId, 'replicaId'), projectId: assertIdentifier(replica.projectId, 'projectId') };
    },
    async claim(serverUrl, credential, leaseMs) {
      const response = objectValue(await post(serverUrl, '/api/worker/runtime-task-v2/claim', credential, { leaseMs }), 'task claim response');
      if (response.ok === false && response.code === 'no-task') return undefined;
      if (response.ok !== true) throw new Error('Central rejected task claim');
      const claim = objectValue(response.claim, 'task claim');
      const requestBytes = decodeBytes(claim.requestBase64, 'request bytes');
      const requestDigest = digestValue(claim.requestDigest, 'request digest');
      if (digestBytes(requestBytes) !== requestDigest) throw new Error('Task request digest does not match');
      const target = objectValue(claim.target, 'task target');
      const environmentProfile = claim.environmentProfile;
      if (environmentProfile !== 'prod-readonly') throw new Error('Task profile is not supported by public Link');
      if (!Number.isInteger(claim.leaseExpiresAt) || Number(claim.leaseExpiresAt) <= 0) throw new Error('Task lease is invalid');
      return {
        taskId: assertIdentifier(claim.taskId, 'taskId'), executionId: assertIdentifier(claim.executionId, 'executionId'),
        ...(claim.operationId === undefined ? {} : { operationId: assertIdentifier(claim.operationId, 'operationId') }),
        bindingRef: assertIdentifier(claim.bindingRef, 'bindingRef'), environmentProfile, requestDigest, requestBytes,
        target: {
          deviceId: assertIdentifier(target.deviceId, 'target.deviceId'), workerId: assertIdentifier(target.workerId, 'target.workerId'),
          projectId: assertIdentifier(target.projectId, 'target.projectId'), replicaId: assertIdentifier(target.replicaId, 'target.replicaId'),
          workspaceId: assertIdentifier(target.workspaceId, 'target.workspaceId'), rootIdentity: digestValue(target.rootIdentity, 'target.rootIdentity')
        }, leaseExpiresAt: Number(claim.leaseExpiresAt), ...(claim.queueMs === undefined ? {} : { queueMs: Number(claim.queueMs) })
      };
    },
    async renew(serverUrl, credential, taskId, leaseMs) { await expectOk(post(serverUrl, '/api/worker/runtime-task-v2/renew', credential, { taskId, leaseMs }), 'task renewal'); },
    async release(serverUrl, credential, taskId) { await expectOk(post(serverUrl, '/api/worker/runtime-task-v2/release', credential, { taskId }), 'task release'); },
    async complete(serverUrl, credential, task, answer) {
      await expectOk(post(serverUrl, '/api/worker/runtime-task-v2/complete', credential, {
        taskId: task.taskId, executionId: task.executionId, environmentProfile: task.environmentProfile,
        requestDigest: task.requestDigest, answerBase64: encodeBytes(answer)
      }), 'task completion');
    },
    async fail(serverUrl, credential, task, reason) {
      await expectOk(post(serverUrl, '/api/worker/runtime-task-v2/fail', credential, {
        taskId: task.taskId, executionId: task.executionId, environmentProfile: task.environmentProfile,
        requestDigest: task.requestDigest, reason
      }), 'task failure');
    }
  };
}

function requirePublicIdentity(serverUrl: string, identity?: PublicLinkRuntimeIdentity): void {
  const url = new URL(httpsServerUrl(serverUrl));
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (!identity && !loopback) throw new Error('Public Link requires an exact package/central compatibility identity before network admission');
}

function digestValue(value: unknown, label: string): PublicLinkDigest {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${label} is invalid`);
  return value as PublicLinkDigest;
}

async function expectOk(response: Promise<unknown>, action: string): Promise<void> {
  const value = objectValue(await response, action);
  if (value.ok !== true) throw new Error(`Central rejected ${action}`);
}

async function request(fetchPort: typeof fetch, serverUrl: string, pathname: string, method: 'GET' | 'POST', credential: string | undefined, body: unknown,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number }): Promise<unknown> {
  const url = new URL(pathname, httpsServerUrl(serverUrl));
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.min(60_000, Math.max(1, options.timeoutMs!)) : 15_000;
  const stop = () => controller.abort(new Error('Central request canceled'));
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  const timer = setTimeout(() => controller.abort(new Error('Central request timed out')), timeoutMs);
  let removeAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const rejectAbort = () => reject(controller.signal.reason);
    removeAbort = () => controller.signal.removeEventListener('abort', rejectAbort);
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    if (controller.signal.aborted) rejectAbort();
  });
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([readResponse(fetchPort, url, pathname, method, credential, body, controller.signal), aborted]);
  } finally {
    clearTimeout(timer); removeAbort(); options.signal?.removeEventListener('abort', stop);
  }
}

async function readResponse(fetchPort: typeof fetch, url: URL, pathname: string, method: 'GET' | 'POST', credential: string | undefined, body: unknown, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchPort(url, {
      method, signal, redirect: 'error',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  } catch { throw new Error(`Central ${method} ${pathname} is unreachable`); }
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error(`Central ${method} ${pathname} returned invalid JSON`); }
  if (response.status < 200 || response.status >= 300) {
    const error = value && typeof value === 'object' && 'code' in value && typeof value.code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value.code) ? `: ${value.code}` : '';
    throw new Error(`Central ${method} ${pathname} failed (${response.status})${error}`);
  }
  return value;
}
