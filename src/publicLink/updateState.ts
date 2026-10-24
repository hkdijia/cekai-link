import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { writePublicLinkFile } from './config.js';

export const updatePaths = (config: string) => {
  const root = `${config}.updates`;
  return { root, packages: path.join(root, 'packages'), state: path.join(root, 'state.json'), pointer: path.join(root, 'current.json'), lock: path.join(root, 'operation.lock') };
};
export type UpdatePhase = 'prepared' | 'stopping' | 'stopped' | 'switching' | 'switched' | 'starting' | 'completed';
export interface PublicLinkUpdateState {
  readonly schemaVersion: 1; readonly token: string; readonly phase: UpdatePhase;
  readonly fromRoot: string; readonly toRoot: string; readonly fromVersion: string; readonly toVersion: string;
  readonly fromArtifact: string; readonly toArtifact: string; readonly runtimePath: string;
  readonly backupPath: string; readonly mappingPath: string; readonly configDigest: string;
  readonly serviceInstalled: boolean; readonly serviceEnabled: boolean;
  readonly serviceDigest?: string;
  readonly direction: 'update' | 'rollback'; readonly lastFailure?: string;
}

export async function readUpdateJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const details = await lstat(file);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 64 * 1024
      || (process.platform !== 'win32' && ((details.mode & 0o077) !== 0 || (process.getuid && details.uid !== process.getuid())))) throw new Error('invalid');
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('升级记录无效；保留材料并联系部署方核对。'); }
}

export async function readUpdateState(config: string): Promise<PublicLinkUpdateState | undefined> {
  const value = await readUpdateJson(updatePaths(config).state); if (!value) return undefined;
  const state = value as unknown as PublicLinkUpdateState;
  const required = ['schemaVersion', 'token', 'phase', 'fromRoot', 'toRoot', 'fromVersion', 'toVersion', 'fromArtifact', 'toArtifact', 'runtimePath', 'backupPath', 'mappingPath', 'configDigest', 'serviceInstalled', 'serviceEnabled', 'direction'];
  if (required.some(key => !(key in value)) || Object.keys(value).some(key => ![...required, 'lastFailure', 'serviceDigest'].includes(key)) || state.schemaVersion !== 1
    || !/^[a-f0-9-]{36}$/.test(state.token) || !['prepared', 'stopping', 'stopped', 'switching', 'switched', 'starting', 'completed'].includes(state.phase)
    || !['update', 'rollback'].includes(state.direction) || typeof state.serviceInstalled !== 'boolean' || typeof state.serviceEnabled !== 'boolean'
    || ![state.fromVersion, state.toVersion].every(v => typeof v === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v))
    || ![state.fromArtifact, state.toArtifact, state.configDigest].every(v => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v))
    || state.lastFailure !== undefined && state.lastFailure !== 'transition-unconfirmed'
    || state.serviceDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(state.serviceDigest)) throw new Error('升级状态不完整；保留材料并联系部署方核对。');
  for (const root of [state.fromRoot, state.toRoot]) if (!managedPackagePath(config, root)) throw new Error('升级包路径不属于本配置的受管目录。');
  const transaction = path.join(updatePaths(config).root, state.token);
  if (state.backupPath !== path.join(transaction, 'config.before.json') || state.mappingPath !== path.join(transaction, 'compatibility.json')
    || !path.isAbsolute(state.runtimePath)) throw new Error('升级恢复路径无效。');
  return state;
}

export const writeUpdateState = (config: string, state: PublicLinkUpdateState) => writePublicLinkFile(updatePaths(config).state, `${JSON.stringify(state)}\n`);
export function managedPackagePath(config: string, root: unknown): root is string {
  return typeof root === 'string' && path.dirname(root) === updatePaths(config).packages && /^[a-f0-9]{64}$/.test(path.basename(root));
}

/** Original npm entry remains stable; selection is confined to this config's verified store. */
export async function selectedUpdateRoot(config: string): Promise<string | undefined> {
  const value = await readUpdateJson(updatePaths(config).pointer); if (!value) return undefined;
  if (Object.keys(value).sort().join(',') !== 'artifactId,root,schemaVersion' || value.schemaVersion !== 1 || !managedPackagePath(config, value.root)
    || value.artifactId !== `sha256:${path.basename(value.root)}`) throw new Error('当前版本入口无效；运行 update resume 或联系部署方。');
  const canonical = await realpath(value.root);
  if (canonical !== path.join(await realpath(updatePaths(config).packages), path.basename(value.root))) throw new Error('当前版本目录归属不匹配。');
  return value.root;
}

export async function assertNoPendingUpdate(config: string): Promise<void> {
  const state = await readUpdateState(config);
  if (state && state.phase !== 'completed' && process.env.CEKAI_LINK_UPDATE_TRANSACTION !== state.token) throw new Error('升级尚未结束；请运行 cekai-link update resume，不要重复启动Link。');
}

/** Dedicated upgrade operation lock; dead operation evidence is moved aside, never a runtime lock. */
export async function withUpdateLock<T>(config: string, action: () => Promise<T>): Promise<T> {
  const locations = updatePaths(config); await mkdir(locations.root, { recursive: true, mode: 0o700 });
  const token = randomUUID(), owner = { pid: process.pid, token };
  for (let attempt = 0; ; attempt++) {
    try { await writePublicLinkFile(locations.lock, JSON.stringify(owner), true); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 1) throw error;
      const old = await readUpdateJson(locations.lock);
      if (!old || !Number.isSafeInteger(old.pid) || Number(old.pid) < 1 || typeof old.token !== 'string') throw new Error('升级操作归属未知；保留记录并联系部署方。');
      try { process.kill(Number(old.pid), 0); throw new Error('另一个升级操作仍在运行。'); }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') throw failure; }
      if (JSON.stringify(await readUpdateJson(locations.lock)) !== JSON.stringify(old)) throw new Error('升级操作归属已变化，请重新读取状态。');
      await rename(locations.lock, path.join(locations.root, `interrupted-${randomUUID()}.json`));
    }
  }
  try { return await action(); }
  finally { if ((await readUpdateJson(locations.lock))?.token === token) await rm(locations.lock); }
}
