import { randomUUID } from 'node:crypto';
import { access, readFile, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicLinkNativeService, type PublicLinkNativeService } from '../adapters/publicLinkService/native.js';
import { createPublicLinkConfigStore, defaultPublicLinkConfigPath, defaultPublicLinkRuntimePath } from './config.js';
import { readPublicLinkSnapshot } from './inspect.js';
import { readPublicSourceRuntimeIdentity, verifyPublicSourcePackage } from './packageIdentity.js';
import { createPublicLinkRuntime, readPublicLinkRuntimeIdentity, readPublicLinkRuntimeStatus } from './runtime.js';
import { readServiceOwner, readServiceRecord, serviceOwnerPath, serviceRecordPath, withServiceLock, writeServiceJson, type PublicLinkServiceRecord } from './serviceFiles.js';
import { assertNoPendingUpdate, readUpdateState } from './updateState.js';

export type PublicLinkServiceAction = 'install' | 'start' | 'stop' | 'uninstall' | 'status';
interface ServiceContext {
  readonly configPath?: string;
  readonly runtimePath?: string;
  readonly packageRoot?: string;
  readonly native?: (record: PublicLinkServiceRecord) => PublicLinkNativeService;
  readonly waitMs?: number;
  readonly enableOnInstall?: boolean;
}

/** Local lifecycle only. Native registration never changes pairing or task state. */
export async function operatePublicLinkService(action: PublicLinkServiceAction, input: ServiceContext = {}): Promise<unknown> {
  const configPath = path.resolve(input.configPath ?? defaultPublicLinkConfigPath());
  const native = input.native ?? createPublicLinkNativeService;
  const read = async () => {
    const record = await readServiceRecord(configPath);
    return { schemaVersion: 1, installed: Boolean(record), enabled: record?.enabled ?? false,
      nativeState: record ? await native(record).query() : 'not-registered',
      ...(record ? { process: await processState(record) } : {}) };
  };
  if (action === 'status') {
    const status = await read();
    const snapshot = await readPublicLinkSnapshot({ configPath, runtimePath: (await readServiceRecord(configPath))?.runtimePath ?? input.runtimePath });
    return { ...status, runtime: snapshot.runtime, nextAction: snapshot.nextAction };
  }
  await assertNoPendingUpdate(configPath);
  return withServiceLock(configPath, async () => {
    let record = await readServiceRecord(configPath);
    if (action === 'install' || action === 'start') {
      if (action === 'start' && !record) throw new Error('Link service is not installed; run cekai-link service install first');
      const proposed = await installationRecord(configPath, input);
      if (record && (record.packageArtifactId !== proposed.packageArtifactId || record.entryPath !== proposed.entryPath
        || record.nodePath !== proposed.nodePath || record.runtimePath !== proposed.runtimePath || record.home !== proposed.home)) {
        throw new Error('Installed service belongs to another package or environment; stop/uninstall it before installing this package');
      }
      // A new terminal need not reproduce the original PATH or other harmless
      // exported settings. Reuse the explicitly installed service environment.
      const desired = record ? { ...record, enabled: action === 'install' ? input.enableOnInstall ?? true : true } : proposed;
      if (record && await processState(record) === 'running') return { ...await read(), action: 'already-running' };
      await assertIdle(desired);
      if (await readServiceOwner(configPath)) throw new Error('A previous service process record remains; inspect ownership before recovery');
      const manager = native(desired);
      const state = await manager.query();
      if (state === 'foreign' || state === 'unknown' || (!record && state !== 'absent')) {
        throw new Error('User service unavailable or name occupied; no registration was changed');
      }
      await writeServiceJson(serviceRecordPath(configPath), desired, !record);
      record = desired;
      if (!desired.enabled) {
        await manager.install();
        return { ...await read(), action: 'installed-disabled' };
      }
      await manager.start();
      await until(async () => await processState(desired) === 'running', input.waitMs);
      return { ...await read(), action: action === 'install' ? 'installed' : 'started' };
    }
    if (!record) return { ...await read(), action: 'not-installed' };
    const manager = native(record);
    const state = await manager.query();
    if (state === 'foreign' || state === 'unknown') throw new Error('User service unavailable or registration changed; no stop/uninstall was performed');
    const owner = await readServiceOwner(configPath);
    if (owner && !alive(owner.pid)) throw new Error('Service exited unexpectedly; preserve process/runtime evidence and inspect before recovery');
    if (owner) {
      const lock = await readRuntimeLock(configPath);
      if (lock && lock.pid !== owner.pid) throw new Error('Runtime belongs to another process; refusing service stop');
    }
    await writeServiceJson(serviceRecordPath(configPath), { ...record, enabled: false });
    // The host observes stop intent and uses the same AbortController as foreground run.
    // No taskkill/kill-by-PID, stale lock deletion or task replay is performed.
    await until(async () => !(await readServiceOwner(configPath)), input.waitMs);
    await manager.stop();
    if (action === 'uninstall') {
      await manager.uninstall();
      await rm(serviceRecordPath(configPath));
    }
    return { ...await read(), action: action === 'uninstall' ? 'uninstalled' : 'stopped' };
  });
}

/** Internal native-manager entry. Runs the existing runtime in the same user account. */
export async function runPublicLinkServiceHost(configPath: string): Promise<void> {
  const record = await readServiceRecord(configPath);
  if (!record || !record.enabled) return;
  const root = process.env.CEKAI_LINK_SOURCE_PACKAGE_ROOT;
  if (!root || verifyPublicSourcePackage(root).packageArtifactId !== record.packageArtifactId
    || await realpath(path.join(root, 'bin', 'cekai-link-source.cjs')) !== await realpath(record.entryPath)
    || await realpath(process.execPath) !== await realpath(record.nodePath) || record.home !== homedir()) {
    throw new Error('Link service package or user changed; reinstall explicitly before starting');
  }
  process.env.CEKAI_LINK_PUBLIC_CONFIG_PATH = record.configPath;
  process.env.CEKAI_LINK_PUBLIC_RUNTIME_PATH = record.runtimePath;
  process.env.CEKAI_LINK_COMPATIBILITY_PATH = record.compatibilityPath ?? '';
  process.env.HOME = record.home;
  process.env.PATH = record.searchPath;
  if (record.codexHome) process.env.CODEX_HOME = record.codexHome;
  if (record.codexExecutable) process.env.CEKAI_CODEX_EXECUTABLE = record.codexExecutable;
  if (record.appData) process.env.APPDATA = record.appData;
  if (record.localAppData) process.env.LOCALAPPDATA = record.localAppData;
  const update = await readUpdateState(configPath);
  if (update?.phase === 'starting' && update.toArtifact === record.packageArtifactId) process.env.CEKAI_LINK_UPDATE_TRANSACTION = update.token;
  await assertNoPendingUpdate(configPath);
  const identity = readPublicLinkRuntimeIdentity();
  await assertIdle(record);
  const owner = { pid: process.pid, token: randomUUID() };
  await writeServiceJson(serviceOwnerPath(configPath), owner, true);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void readServiceRecord(configPath).then(current => {
      if (!current?.enabled || JSON.stringify({ ...current, enabled: true }) !== JSON.stringify(record)) stop();
    }, stop).finally(() => { checking = false; });
  }, 250);
  try {
    // Handle a concurrent stop before serve acquires its exclusive runtime lock.
    if (!(await readServiceRecord(configPath))?.enabled) return;
    await createPublicLinkRuntime({ identity }).serve(controller.signal);
  } finally {
    clearInterval(timer);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if ((await readServiceOwner(configPath))?.token === owner.token) await rm(serviceOwnerPath(configPath));
  }
}

async function installationRecord(configPath: string, input: ServiceContext): Promise<PublicLinkServiceRecord> {
  const root = input.packageRoot ?? process.env.CEKAI_LINK_SOURCE_PACKAGE_ROOT;
  if (!root) throw new Error('Service install requires the installed npm package entry');
  const build = verifyPublicSourcePackage(root);
  const config = await createPublicLinkConfigStore(configPath).load();
  if (!config?.workspace) throw new Error('Complete cekai-link setup and workspace registration before installing the service');
  const compatibilityPath = process.env.CEKAI_LINK_COMPATIBILITY_PATH?.trim() || config.compatibilityPath;
  readPublicSourceRuntimeIdentity(root, compatibilityPath);
  const runtimePath = path.resolve(input.runtimePath ?? defaultPublicLinkRuntimePath());
  const home = homedir();
  const record: PublicLinkServiceRecord = {
    version: 1, configPath, runtimePath, nodePath: await realpath(process.execPath),
    entryPath: await realpath(path.join(root, 'bin', 'cekai-link-source.cjs')),
    packageArtifactId: build.packageArtifactId, home, searchPath: process.env.PATH ?? '',
    ...(process.env.CODEX_HOME ? { codexHome: path.resolve(process.env.CODEX_HOME) } : {}),
    ...(process.env.CEKAI_CODEX_EXECUTABLE?.trim() ? { codexExecutable: path.resolve(process.env.CEKAI_CODEX_EXECUTABLE.trim()) } : {}),
    ...(process.platform === 'win32' && process.env.APPDATA ? { appData: path.resolve(process.env.APPDATA) } : {}),
    ...(process.platform === 'win32' && process.env.LOCALAPPDATA ? { localAppData: path.resolve(process.env.LOCALAPPDATA) } : {}),
    ...(process.env.CEKAI_LINK_COMPATIBILITY_PATH?.trim() ? { compatibilityPath: process.env.CEKAI_LINK_COMPATIBILITY_PATH.trim() } : {}), enabled: input.enableOnInstall ?? true
  };
  // Validate before writing or invoking a manager; control characters cannot reach definitions.
  for (const value of Object.values(record)) if (typeof value === 'string' && /[\x00-\x1f\x7f]/.test(value)) throw new Error('Link service environment contains unsupported characters');
  if (!record.searchPath) throw new Error('Link service needs the normal executable search path');
  return record;
}
async function assertIdle(record: PublicLinkServiceRecord): Promise<void> {
  if (await exists(`${record.configPath}.runtime.lock`)) throw new Error('A foreground runtime or recovery lock exists; stop it normally and inspect before service start');
  if ((await readPublicLinkRuntimeStatus(record.runtimePath))?.currentTask) throw new Error('Link task recovery is pending; service start will not replay it');
}
async function processState(record: PublicLinkServiceRecord): Promise<'running' | 'starting' | 'stopped' | 'recovery-required'> {
  const owner = await readServiceOwner(record.configPath);
  if (!owner) return 'stopped';
  if (!alive(owner.pid)) return 'recovery-required';
  const lock = await readRuntimeLock(record.configPath);
  if (!lock) return 'starting';
  if (lock.pid !== owner.pid) return 'recovery-required';
  const runtime = await readPublicLinkRuntimeStatus(record.runtimePath);
  if (!runtime || runtime.pid !== owner.pid || runtime.state === 'starting') return 'starting';
  return runtime.state === 'running' || runtime.state === 'busy' ? 'running' : 'recovery-required';
}
async function readRuntimeLock(configPath: string): Promise<{ pid: number } | undefined> {
  try {
    const value = JSON.parse(await readFile(`${configPath}.runtime.lock`, 'utf8'));
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.token !== 'string') throw new Error('invalid');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Runtime lock is invalid; preserve it for recovery');
  }
}
async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } }
async function until(check: () => Promise<boolean>, budget = 15_000): Promise<void> {
  const deadline = Date.now() + budget;
  do { if (await check()) return; await delay(100); } while (Date.now() < deadline);
  throw new Error('Service transition is unconfirmed; preserve registration/runtime and inspect before retrying');
}
