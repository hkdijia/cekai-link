import { createHash } from 'node:crypto';
import path from 'node:path';

export const PUBLIC_LINK_PROTOCOL_VERSION = 1 as const;
export const PUBLIC_LINK_PROFILE = 'prod-readonly' as const;

export type PublicLinkOs = 'windows' | 'macos' | 'linux';
export type PublicLinkWorkspaceKind = 'git-root' | 'collection' | 'folder';
export type PublicLinkProfile = typeof PUBLIC_LINK_PROFILE;
export type PublicLinkDigest = `sha256:${string}`;

export interface PublicLinkWorkspace {
  readonly replicaId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly rootIdentity: PublicLinkDigest;
  readonly rootDigest: string;
  readonly canonicalRoot: string;
  readonly os: PublicLinkOs;
  readonly workspaceKind: PublicLinkWorkspaceKind;
}

export interface PublicLinkConfig {
  readonly version: 1;
  readonly serverUrl: string;
  readonly credential: string;
  readonly workerId: string;
  readonly deviceId: string;
  readonly deviceName: string;
  /** Local file reference only; never sent to Central. */
  readonly compatibilityPath?: string;
  readonly workspace?: PublicLinkWorkspace;
}

export interface PublicLinkRuntimeIdentity {
  readonly role: 'link';
  readonly publicPackageArtifactId?: PublicLinkDigest;
  readonly releaseId: PublicLinkDigest;
  readonly sourceRevision: string;
  readonly protocolVersion: number;
  readonly contractDigest: PublicLinkDigest;
  readonly roleDigest: PublicLinkDigest;
  /** Opaque compatibility fields, not bundled tools or capabilities. */
  readonly componentDigests: { readonly mcp: PublicLinkDigest; readonly schemas: PublicLinkDigest; readonly skills: PublicLinkDigest };
}

/** Existing Central health contract, without message bodies or workspace paths. */
export interface PublicLinkRuntimeHealth {
  readonly artifactIntegrity: 'verified' | 'unverified' | 'invalid';
  readonly agentRuntime: {
    readonly total: number;
    readonly active: number;
    readonly recoveryRequired: number;
    readonly resumable: number;
  };
}

export interface PublicLinkCentralSnapshot {
  readonly schemaVersion: 1;
  readonly conversationBinding: 'active' | 'required';
  readonly activeBindingCount: number;
  readonly registeredProjectCount: number;
  readonly centralCompatibility: 'accepted' | 'compatible' | 'staged' | 'incompatible' | 'missing' | 'unconfigured' | 'unknown';
  readonly dispatchReady: boolean | null;
}

export interface PublicLinkRuntimeTask {
  readonly taskId: string;
  readonly executionId: string;
  readonly operationId?: string;
  readonly bindingRef: string;
  readonly environmentProfile: PublicLinkProfile;
  readonly requestDigest: PublicLinkDigest;
  readonly requestBytes: Uint8Array;
  readonly target: {
    readonly deviceId: string;
    readonly workerId: string;
    readonly projectId: string;
    readonly replicaId: string;
    readonly workspaceId: string;
    readonly rootIdentity: PublicLinkDigest;
  };
  readonly leaseExpiresAt: number;
  readonly queueMs?: number;
}

export type PublicLinkFailureReason =
  | 'runner-failed'
  | 'completion-failed'
  | 'lease-lost'
  | 'codex-idle-timeout'
  | 'codex-post-output-completion-timeout'
  | 'codex-maximum-duration-timeout';

export function parsePublicLinkConfig(value: unknown): PublicLinkConfig {
  const record = objectValue(value, 'Link configuration');
  assertKeys(record, ['version', 'serverUrl', 'credential', 'workerId', 'deviceId', 'deviceName', 'workspace', 'compatibilityPath'], 'Link configuration');
  if (record.version !== 1) throw new Error('Link configuration version is unsupported');
  const base = {
    version: 1 as const,
    serverUrl: httpsServerUrl(stringValue(record.serverUrl, 'serverUrl')),
    credential: stringValue(record.credential, 'credential'),
    workerId: stringValue(record.workerId, 'workerId'),
    deviceId: stringValue(record.deviceId, 'deviceId'),
    deviceName: stringValue(record.deviceName, 'deviceName'),
    ...(record.compatibilityPath === undefined ? {} : { compatibilityPath: absoluteLocalPath(record.compatibilityPath) })
  };
  if (record.workspace === undefined) return base;
  return { ...base, workspace: parseWorkspace(record.workspace) };
}

function absoluteLocalPath(value: unknown): string {
  const result = stringValue(value, 'compatibilityPath');
  if (!path.isAbsolute(result)) throw new Error('compatibilityPath is invalid');
  return result;
}

export function parseWorkspace(value: unknown): PublicLinkWorkspace {
  const record = objectValue(value, 'workspace');
  assertKeys(record, ['replicaId', 'projectId', 'workspaceId', 'rootIdentity', 'rootDigest', 'canonicalRoot', 'os', 'workspaceKind'], 'workspace');
  const os = record.os;
  const workspaceKind = record.workspaceKind;
  if (os !== 'windows' && os !== 'macos' && os !== 'linux') throw new Error('workspace.os is invalid');
  if (workspaceKind !== 'git-root' && workspaceKind !== 'collection' && workspaceKind !== 'folder') throw new Error('workspace kind is invalid');
  return {
    replicaId: stringValue(record.replicaId, 'replicaId'),
    projectId: stringValue(record.projectId, 'projectId'),
    workspaceId: stringValue(record.workspaceId, 'workspaceId'),
    rootIdentity: digestValue(record.rootIdentity, 'rootIdentity'),
    rootDigest: stringValue(record.rootDigest, 'rootDigest'),
    canonicalRoot: stringValue(record.canonicalRoot, 'canonicalRoot'),
    os,
    workspaceKind
  };
}

export function parseCentralSnapshot(value: unknown): PublicLinkCentralSnapshot {
  const root = objectValue(value, 'Central snapshot');
  if (root.ok !== true) throw new Error('Central snapshot response is not successful');
  const snapshot = objectValue(root.snapshot, 'Central snapshot');
  if (snapshot.schemaVersion !== 1) throw new Error('Central snapshot schema is unsupported');
  if (snapshot.conversationBinding !== 'active' && snapshot.conversationBinding !== 'required') throw new Error('Central binding state is invalid');
  if (!Number.isInteger(snapshot.activeBindingCount) || Number(snapshot.activeBindingCount) < 0) throw new Error('Central binding count is invalid');
  if (!Number.isInteger(snapshot.registeredProjectCount) || Number(snapshot.registeredProjectCount) < 0) throw new Error('Central project count is invalid');
  const compatibility = snapshot.centralCompatibility;
  const allowed = ['accepted', 'compatible', 'staged', 'incompatible', 'missing', 'unconfigured', 'unknown'] as const;
  if (!allowed.includes(compatibility as typeof allowed[number])) throw new Error('Central compatibility is invalid');
  if (snapshot.dispatchReady !== null && typeof snapshot.dispatchReady !== 'boolean') throw new Error('Central dispatch state is invalid');
  return {
    schemaVersion: 1,
    conversationBinding: snapshot.conversationBinding,
    activeBindingCount: Number(snapshot.activeBindingCount),
    registeredProjectCount: Number(snapshot.registeredProjectCount),
    centralCompatibility: compatibility as PublicLinkCentralSnapshot['centralCompatibility'],
    dispatchReady: snapshot.dispatchReady as boolean | null
  };
}

export function digestBytes(value: Uint8Array): PublicLinkDigest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function encodeBytes(value: Uint8Array): string { return Buffer.from(value).toString('base64'); }

export function decodeBytes(value: unknown, label: string): Uint8Array {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is missing`);
  try {
    const bytes = Uint8Array.from(Buffer.from(value, 'base64'));
    if (Buffer.from(bytes).toString('base64') !== value) throw new Error();
    return bytes;
  } catch { throw new Error(`${label} is invalid`); }
}

export function digestValue(value: unknown, label: string): PublicLinkDigest {
  const result = stringValue(value, label);
  if (!/^sha256:[a-f0-9]{64}$/.test(result)) throw new Error(`${label} is invalid`);
  return result as PublicLinkDigest;
}

export function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) throw new Error(`${label} is invalid`);
  return value;
}

export function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

export function httpsServerUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Central URL is invalid'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('Central URL must use HTTPS; HTTP is allowed only for loopback testing');
  }
  return value.replace(/\/$/, '');
}

export function assertIdentifier(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (result.length > 256 || /[\\/\r\n\t]/.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function assertKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedSet.has(key))) throw new Error(`${label} contains unsupported fields`);
}
