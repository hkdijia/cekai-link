import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createPublicLinkApi } from './api.js';
import { createPublicLinkConfigStore, defaultPublicLinkRuntimePath } from './config.js';
import { readPublicLinkRuntimeStatus } from './runtime.js';
import { verifyPublicSourcePackage, readPublicSourceRuntimeIdentity } from './packageIdentity.js';
import { digestValue, type PublicLinkCentralSnapshot, type PublicLinkConfig } from './protocol.js';

export type PublicLinkOverall = 'ready' | 'setup-required' | 'degraded' | 'offline' | 'unavailable';

export interface PublicLinkSnapshot {
  readonly schemaVersion: 1;
  readonly overall: PublicLinkOverall;
  readonly setup: {
    readonly installation: 'installed';
    readonly pairing: 'paired' | 'required' | 'unavailable';
    readonly workspaceRegistration: 'registered' | 'required' | 'unavailable';
    readonly conversationBinding: 'active' | 'required' | 'unavailable';
  };
  readonly runtime: {
    readonly launcher: 'running' | 'starting' | 'stopped' | 'failed' | 'unavailable';
    readonly heartbeat: 'fresh' | 'stale' | 'unknown';
    readonly engine: 'stopped' | 'ready' | 'busy' | 'failed' | 'unknown';
  };
  readonly release: {
    readonly artifactMode: 'immutable' | 'missing' | 'invalid' | 'unknown';
    readonly artifactIntegrity: 'verified' | 'invalid' | 'unknown';
    readonly runningRevision?: string;
    readonly publicSourceRevision?: string;
    readonly packageArtifactId?: string;
    readonly compatibilityMapping?: 'available' | 'unavailable';
    readonly centralCompatibility: 'accepted' | 'compatible' | 'staged' | 'incompatible' | 'missing' | 'unconfigured' | 'unknown';
    readonly centralDispatchReady: boolean | null;
  };
  readonly scope: { readonly registeredProjectCount: number | null };
  readonly sources: { readonly localConfiguration: 'available' | 'invalid'; readonly central: 'available' | 'unavailable' };
  readonly nextAction: { readonly code: 'pair-device' | 'register-workspace' | 'start-link' | 'bind-conversation' | 'retry-central-inspection' | 'ask-project-question'; readonly label: string; readonly reason: string };
}

export async function readPublicLinkSnapshot(input: {
  readonly configPath?: string;
  readonly runtimePath?: string;
  readonly artifactRoot?: string;
  readonly api?: ReturnType<typeof createPublicLinkApi>;
} = {}): Promise<PublicLinkSnapshot> {
  const store = createPublicLinkConfigStore(input.configPath);
  let config: PublicLinkConfig | undefined;
  let localConfiguration: PublicLinkSnapshot['sources']['localConfiguration'] = 'available';
  try { config = await store.load(); } catch { localConfiguration = 'invalid'; }
  const artifact = await readArtifactState(input.artifactRoot);
  const runtime = await readRuntime(input.runtimePath);
  let central: PublicLinkCentralSnapshot | undefined;
  if (config) {
    try { central = await (input.api ?? createPublicLinkApi()).readSnapshot(config.serverUrl, config.credential); } catch { central = undefined; }
  }
  const pairing = localConfiguration === 'invalid' ? 'unavailable' : config ? 'paired' : 'required';
  const workspaceRegistration = localConfiguration === 'invalid' ? 'unavailable' : config?.workspace ? 'registered' : 'required';
  const alive = runtime ? processExists(runtime.pid) : false;
  const launcher = runtime?.state === 'running' || runtime?.state === 'busy' ? alive ? 'running' : 'stopped' : runtime?.state === 'starting' ? alive ? 'starting' : 'stopped' : runtime?.state === 'failed' ? 'failed' : runtime ? 'stopped' : 'unavailable';
  const age = runtime ? Date.now() - Date.parse(runtime.updatedAt) : NaN;
  const heartbeat = runtime && age >= 0 && age < 90_000 ? 'fresh' : runtime ? 'stale' : 'unknown';
  const engine = !alive ? 'stopped' : runtime?.state === 'busy' ? 'busy' : runtime?.state === 'running' ? 'ready' : runtime?.state === 'failed' ? 'failed' : 'stopped';
  const centralCompatibility = central?.centralCompatibility ?? 'unknown';
  const centralDispatchReady = central?.dispatchReady ?? null;
  const next = selectNext({ pairing, workspaceRegistration, launcher, heartbeat, artifact, central, centralCompatibility, centralDispatchReady });
  return {
    schemaVersion: 1, overall: next.overall,
    setup: { installation: 'installed', pairing, workspaceRegistration, conversationBinding: central?.conversationBinding ?? 'unavailable' },
    runtime: { launcher, heartbeat, engine },
    release: { artifactMode: artifact.mode, artifactIntegrity: artifact.integrity, ...(artifact.revision ? { runningRevision: artifact.revision } : {}),
      ...(artifact.source ? { publicSourceRevision: artifact.source.revision, packageArtifactId: artifact.source.artifactId, compatibilityMapping: artifact.source.mapping } : {}), centralCompatibility, centralDispatchReady },
    scope: { registeredProjectCount: config?.workspace ? 1 : config ? 0 : null },
    sources: { localConfiguration, central: central ? 'available' : 'unavailable' },
    nextAction: next.action
  };
}

async function readArtifactState(root = process.env.CEKAI_LINK_ARTIFACT_ROOT): Promise<{ mode: 'immutable' | 'missing' | 'invalid' | 'unknown'; integrity: 'verified' | 'invalid' | 'unknown'; revision?: string;
  source?: { revision: string; artifactId: string; mapping: 'available' | 'unavailable' } }> {
  const sourceRoot = process.env.CEKAI_LINK_SOURCE_PACKAGE_ROOT;
  if (sourceRoot) {
    try {
      const build = verifyPublicSourcePackage(sourceRoot);
      let mapping: 'available' | 'unavailable' = 'unavailable';
      try { readPublicSourceRuntimeIdentity(sourceRoot); mapping = 'available'; } catch { /* inspection must work before operator admission */ }
      return { mode: 'immutable', integrity: 'verified', source: { revision: build.publicSourceRevision, artifactId: build.packageArtifactId, mapping } };
    } catch { return { mode: 'invalid', integrity: 'invalid' }; }
  }
  if (!root) return { mode: 'unknown', integrity: 'unknown' };
  const manifestPath = `${root}/artifact-manifest.json`;
  if (!existsSync(manifestPath)) return { mode: 'missing', integrity: 'invalid' };
  try {
    const value = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    const artifactId = digestValue(value.artifactId, 'artifactId');
    const treeDigest = digestValue(value.treeDigest, 'treeDigest');
    if (typeof value.revision !== 'string' || !value.revision || typeof value.entryRelativePath !== 'string'
      || !Array.isArray(value.files) || value.files.length < 2 || typeof value.entryDigest !== 'string') throw new Error();
    const files = value.files.map((entry) => {
      if (typeof entry !== 'string' || !/^dist\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(entry)
        || entry.split('/').some((segment) => segment === '.' || segment === '..')) throw new Error();
      return entry;
    }).sort();
    if (new Set(files).size !== files.length || !files.includes(value.entryRelativePath) || !files.includes('dist/release-manifest.json')) throw new Error();
    const hashFiles = async (selected: readonly string[]): Promise<string> => {
      const hash = createHash('sha256');
      for (const file of selected) {
        const absolute = path.join(root, file);
        const details = await lstat(absolute);
        if (!details.isFile() || details.isSymbolicLink()) throw new Error();
        hash.update(file); hash.update('\0'); hash.update(await readFile(absolute)); hash.update('\0');
      }
      return `sha256:${hash.digest('hex')}`;
    };
    const observedTreeDigest = await hashFiles(files);
    if (observedTreeDigest !== treeDigest || await hashFiles(files.filter((file) => file !== 'dist/release-manifest.json')) !== value.entryDigest
      || `sha256:${createHash('sha256').update(String(value.revision)).update('\0').update(treeDigest).digest('hex')}` !== artifactId) throw new Error();
    const release = JSON.parse(await readFile(path.join(root, 'dist/release-manifest.json'), 'utf8')) as Record<string, unknown>;
    if (release.releaseId !== value.releaseId || release.sourceRevision !== value.revision) throw new Error();
    return { mode: 'immutable', integrity: 'verified', revision: value.revision };
  } catch { return { mode: 'invalid', integrity: 'invalid' }; }
}

async function readRuntime(runtimePath?: string) {
  try { return await readPublicLinkRuntimeStatus(runtimePath ?? defaultPublicLinkRuntimePath()); }
  catch { return undefined; }
}

function selectNext(input: {
  pairing: PublicLinkSnapshot['setup']['pairing']; workspaceRegistration: PublicLinkSnapshot['setup']['workspaceRegistration']; launcher: PublicLinkSnapshot['runtime']['launcher'];
  heartbeat: PublicLinkSnapshot['runtime']['heartbeat'];
  artifact: { mode: string; integrity: string; source?: { mapping: 'available' | 'unavailable' } }; central?: PublicLinkCentralSnapshot; centralCompatibility: PublicLinkSnapshot['release']['centralCompatibility']; centralDispatchReady: boolean | null;
}): { overall: PublicLinkOverall; action: PublicLinkSnapshot['nextAction'] } {
  if (input.pairing !== 'paired') return decision('setup-required', 'pair-device', 'Pair this device before running Link', 'No local Central credential is configured.');
  if (input.workspaceRegistration !== 'registered') return decision('setup-required', 'register-workspace', 'Register a workspace', 'This device is paired but has no local workspace registration.');
  if (input.artifact.mode !== 'immutable' || input.artifact.integrity !== 'verified') return decision('degraded', 'retry-central-inspection', 'Verify the Link package', 'The packaged runtime identity is unavailable or invalid.');
  if (input.artifact.source?.mapping === 'unavailable') return decision('degraded', 'retry-central-inspection', 'Configure the owner-provided Central compatibility mapping', 'This source package has no valid exact Central mapping; network admission is blocked.');
  if (input.launcher === 'failed') return decision('degraded', 'retry-central-inspection', 'Inspect the Link runtime', 'The last Link runtime pass failed.');
  if (input.launcher === 'stopped' || input.launcher === 'unavailable') return decision('offline', 'start-link', 'Run cekai-link run', 'The read-only runtime is not running.');
  if (input.launcher === 'starting') return decision('degraded', 'retry-central-inspection', 'Wait for Link startup', 'The owning runtime has not finished startup.');
  if (input.heartbeat !== 'fresh') return decision('degraded', 'retry-central-inspection', 'Inspect the owning Link process', 'The local runtime status is stale; readiness cannot be inferred from it.');
  if (!input.central) return decision('degraded', 'retry-central-inspection', 'Retry Central inspection', 'Central did not return an authoritative snapshot.');
  if (input.central.conversationBinding === 'required') return decision('setup-required', 'bind-conversation', 'Bind the target conversation', 'Central has not assigned a conversation to this workspace.');
  if (input.centralDispatchReady !== true || !['accepted', 'compatible', 'unconfigured'].includes(input.centralCompatibility)) return decision('degraded', 'retry-central-inspection', 'Resolve Central compatibility', 'Central has not accepted this Link runtime.');
  return decision('ready', 'ask-project-question', 'Ask a read-only project question', 'Pairing, workspace registration, runtime identity and Central readiness are available.');
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'; }
}

function decision(overall: PublicLinkOverall, code: PublicLinkSnapshot['nextAction']['code'], label: string, reason: string): { overall: PublicLinkOverall; action: PublicLinkSnapshot['nextAction'] } {
  return { overall, action: { code, label, reason } };
}
