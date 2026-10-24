import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createPublicLinkApi } from './api.js';
import { downloadPublicLinkCompatibility, saveDownloadedCompatibility } from './compatibility.js';
import { createPublicLinkConfigStore, defaultPublicLinkConfigPath, defaultPublicLinkRuntimePath, writePublicLinkFile } from './config.js';
import { verifyPublicSourcePackage } from './packageIdentity.js';
import { readPublicLinkRuntimeStatus } from './runtime.js';
import { readServiceOwner, readServiceRecord } from './serviceFiles.js';
import { askPublicLinkQuestion } from './setup.js';
import { exactUpdateVersion, prepareUpdatePackage, readUpdatePackage, retainUpdatePackage } from './updatePackage.js';
import { readUpdateState, selectedUpdateRoot, updatePaths, withUpdateLock, writeUpdateState, type PublicLinkUpdateState, type UpdatePhase } from './updateState.js';

const execute = promisify(execFile);
const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const configShape = (value: Record<string, unknown>) => { const result = { ...value }; delete result.compatibilityPath; return JSON.stringify(result); };
export type PublicUpdateCommand = { readonly action: 'status' }
  | { readonly action: 'resume'; readonly yes: boolean }
  | { readonly action: 'rollback'; readonly yes: boolean }
  | { readonly action: 'apply'; readonly target: string; readonly yes: boolean };

export async function runPublicLinkUpdate(command: PublicUpdateCommand, options: {
  readonly configPath?: string; readonly runtimePath?: string; readonly packageRoot?: string;
  readonly fetch?: typeof fetch; readonly confirm?: (plan: string) => Promise<boolean>;
  readonly invoke?: (root: string, args: readonly string[], environment: NodeJS.ProcessEnv) => Promise<void>;
  readonly afterPhase?: (phase: UpdatePhase) => Promise<void>;
} = {}): Promise<unknown> {
  const configPath = options.configPath ?? defaultPublicLinkConfigPath();
  if (command.action === 'status') {
    const state = await readUpdateState(configPath);
    return state ? { schemaVersion: 1, phase: state.phase, fromVersion: state.fromVersion, toVersion: state.toVersion, direction: state.direction,
      nextAction: state.phase === 'completed' ? 'cekai-link inspect' : 'cekai-link update resume' } : { schemaVersion: 1, phase: 'none', nextAction: 'cekai-link inspect' };
  }
  const packageRoot = options.packageRoot ?? process.env.CEKAI_LINK_SOURCE_PACKAGE_ROOT;
  if (!packageRoot) throw new Error('请通过已安装的cekai-link入口执行升级。');
  verifyPublicSourcePackage(packageRoot, { allowPreviousInventory: true });
  const store = createPublicLinkConfigStore(configPath), paths = updatePaths(configPath);
  return withUpdateLock(configPath, async () => {
    const previous = await readUpdateState(configPath);
    if (command.action === 'apply' && previous && previous.phase !== 'completed') throw new Error('上次升级未结束；请先运行 cekai-link update resume。');
    const config = await store.load(); if (!config?.workspace) throw new Error('请先完成 cekai-link setup 和工作区登记。');
    let state: PublicLinkUpdateState;
    if (command.action === 'resume') {
      if (!previous) throw new Error('没有待续接的升级。');
      if (previous.phase === 'completed') return { ok: true, phase: 'completed', version: previous.toVersion, changed: false };
      state = previous;
    } else {
      const currentRoot = await selectedUpdateRoot(configPath) ?? packageRoot;
      const current = verifyPublicSourcePackage(currentRoot, { allowPreviousInventory: true });
      let next: { root: string; build: ReturnType<typeof verifyPublicSourcePackage> };
      if (command.action === 'rollback') {
        if (!previous) throw new Error('没有升级记录中的旧版本可恢复。');
        if (![previous.toArtifact, previous.fromArtifact].includes(current.packageArtifactId)) throw new Error('当前版本与升级记录不符，请先inspect。');
        next = { root: previous.fromRoot, build: verifyPublicSourcePackage(previous.fromRoot, { allowPreviousInventory: true }) };
      } else {
        next = await prepareUpdatePackage(await readUpdatePackage(command.target, options.fetch), paths.packages);
        if (exactUpdateVersion.test(command.target) && next.build.packageVersion !== command.target) throw new Error('指定版本与安装包版本不一致。');
      }
      const recovering = command.action === 'rollback' && previous?.phase !== 'completed';
      if (next.build.packageArtifactId === current.packageArtifactId && !recovering) return { ok: true, changed: false, version: current.packageVersion };
      if (next.build.packageArtifactId !== current.packageArtifactId && next.build.packageVersion === current.packageVersion) throw new Error('同版本不同包不可作为升级；保留原发行字节。');
      if (Number(next.build.packageVersion.split('.')[0]) < 1) throw new Error('统一升级入口仅支持1.0及以上版本；0.1.5按原完整回退指引处理。');
      const mapping = await downloadPublicLinkCompatibility(config.serverUrl, next.build.packageArtifactId, { fetch: options.fetch });
      const service = await readServiceRecord(configPath);
      await assertIdle(configPath, service?.runtimePath ?? previous?.runtimePath ?? options.runtimePath ?? defaultPublicLinkRuntimePath(), Boolean(service));
      const plan = `将 Link ${current.packageVersion} 升级/恢复到 ${next.build.packageVersion}。保留配对和工作区；${service ? '正常停止并恢复原后台服务状态' : '保持前台手工启动'}。失败时运行 update resume 或按记录恢复。确认？[y/N]`;
      if (!command.yes && !(await (options.confirm ?? (async value => /^y(?:es)?$/i.test((await askPublicLinkQuestion(value, false))?.trim() ?? '')))(plan))) return { ok: true, changed: false, canceled: true };
      // Confirm against fresh state immediately before the first lifecycle mutation.
      await assertIdle(configPath, service?.runtimePath ?? options.runtimePath ?? defaultPublicLinkRuntimePath(), Boolean(service));
      const latest = await store.load(); if (JSON.stringify(latest) !== JSON.stringify(config)) throw new Error('确认期间配置发生变化，请重新检查。');
      const token = randomUUID(), transaction = path.join(paths.root, token); await mkdir(transaction, { mode: 0o700 });
      const backupPath = path.join(transaction, 'config.before.json'), mappingPath = path.join(transaction, 'compatibility.json');
      const bytes = await readFile(configPath, 'utf8'); await writePublicLinkFile(backupPath, bytes, true);
      const originalService = service ?? (recovering && previous?.serviceDigest
        ? await readServiceRecord(configPath, `${previous.backupPath}.service.json`) : undefined);
      const serviceBytes = originalService ? JSON.stringify(originalService) : undefined;
      if (serviceBytes) await writePublicLinkFile(`${backupPath}.service.json`, serviceBytes, true);
      const fromRoot = await retainUpdatePackage(currentRoot, paths.packages);
      await saveDownloadedCompatibility({ filePath: mappingPath, packageRoot: next.root, workspaceRoot: config.workspace.canonicalRoot, mapping });
      state = { schemaVersion: 1, token, phase: 'prepared', fromRoot, toRoot: next.root, fromVersion: current.packageVersion, toVersion: next.build.packageVersion,
        fromArtifact: current.packageArtifactId, toArtifact: next.build.packageArtifactId, runtimePath: service?.runtimePath ?? options.runtimePath ?? defaultPublicLinkRuntimePath(),
        backupPath, mappingPath, configDigest: digest(bytes), serviceInstalled: recovering ? previous!.serviceInstalled : Boolean(service), serviceEnabled: recovering ? previous!.serviceEnabled : service?.enabled ?? false,
        ...(serviceBytes ? { serviceDigest: digest(serviceBytes) } : {}), direction: command.action === 'rollback' ? 'rollback' : 'update' };
      await writeUpdateState(configPath, state); await options.afterPhase?.('prepared');
    }
    const invoke = options.invoke ?? (async (root, args, environment) => {
      verifyPublicSourcePackage(root, { allowPreviousInventory: true });
      // Already-verified direct CLI avoids recursively following the stable pointer.
      try { await execute(process.execPath, [path.join(root, 'dist/publicLink/cli.js'), ...args], { env: environment, timeout: 90_000, maxBuffer: 64 * 1024, windowsHide: true }); }
      catch { throw new Error('后台服务转换未确认；保留材料并运行 cekai-link update resume。'); }
    });
    const environment: NodeJS.ProcessEnv = { ...process.env, CEKAI_LINK_PUBLIC_CONFIG_PATH: configPath, CEKAI_LINK_PUBLIC_RUNTIME_PATH: state.runtimePath,
      CEKAI_LINK_UPDATE_TRANSACTION: state.token, CEKAI_LINK_COMPATIBILITY_PATH: '' };
    if (state.serviceDigest) {
      const bytes = await readFile(`${state.backupPath}.service.json`, 'utf8'); if (digest(bytes) !== state.serviceDigest) throw new Error('原服务环境备份发生变化。');
      const original = await readServiceRecord(configPath, `${state.backupPath}.service.json`);
      if (!original) throw new Error('原服务环境不可用。');
      environment.PATH = original.searchPath;
      for (const [key, value] of [['CODEX_HOME', original.codexHome], ['CEKAI_CODEX_EXECUTABLE', original.codexExecutable], ['APPDATA', original.appData], ['LOCALAPPDATA', original.localAppData]] as const) {
        if (value) environment[key] = value;
      }
    }
    const publish = async (phase: UpdatePhase) => { state = { ...state, phase, lastFailure: undefined }; await writeUpdateState(configPath, state); await options.afterPhase?.(phase); };
    try {
      for (const [root, artifact] of [[state.fromRoot, state.fromArtifact], [state.toRoot, state.toArtifact]]) if (verifyPublicSourcePackage(root!, { allowPreviousInventory: true }).packageArtifactId !== artifact) throw new Error('升级保留包发生变化。');
      const backup = await readFile(state.backupPath, 'utf8'); if (digest(backup) !== state.configDigest) throw new Error('升级备份发生变化。');
      const fresh = await store.load(); if (!fresh || configShape(fresh as unknown as Record<string, unknown>) !== configShape(JSON.parse(backup))) throw new Error('配置身份已变化，保留最新配置并联系部署方。');
      // Every resume rechecks current Central approval, never trusts a saved mapping alone.
      const mapping = await downloadPublicLinkCompatibility(fresh.serverUrl, state.toArtifact as `sha256:${string}`, { fetch: options.fetch });
      await saveDownloadedCompatibility({ filePath: state.mappingPath, packageRoot: state.toRoot, workspaceRoot: fresh.workspace?.canonicalRoot, mapping });
      if (['prepared', 'stopping'].includes(state.phase)) {
        await assertIdle(configPath, state.runtimePath, state.serviceInstalled);
        await publish('stopping');
        if (await readServiceRecord(configPath)) await invoke(packageRoot, ['service', 'uninstall'], { ...environment, CEKAI_LINK_SOURCE_PACKAGE_ROOT: packageRoot });
        await assertIdle(configPath, state.runtimePath, false);
        await publish('stopped');
      }
      if (['stopped', 'switching'].includes(state.phase)) {
        await assertIdle(configPath, state.runtimePath, false); await publish('switching');
        await store.save({ ...JSON.parse(backup), compatibilityPath: state.mappingPath });
        await writePublicLinkFile(paths.pointer, `${JSON.stringify({ schemaVersion: 1, root: state.toRoot, artifactId: state.toArtifact })}\n`);
        await publish('switched');
      }
      if (['switched', 'starting'].includes(state.phase)) {
        await publish('starting');
        if (state.serviceInstalled) await invoke(state.toRoot, ['service', 'install', ...(state.serviceEnabled ? [] : ['--disabled'])], { ...environment, CEKAI_LINK_SOURCE_PACKAGE_ROOT: state.toRoot });
        if (state.serviceInstalled && state.serviceEnabled) await createPublicLinkApi(options.fetch).readSnapshot(fresh.serverUrl, fresh.credential).then(snapshot => {
          if (snapshot.dispatchReady !== true || !['accepted', 'compatible'].includes(snapshot.centralCompatibility)) throw new Error('Central准入尚未确认。');
        });
        await publish('completed');
      }
      return { ok: true, changed: true, phase: state.phase, version: state.toVersion, serviceRestored: state.serviceInstalled, serviceEnabled: state.serviceEnabled,
        nextAction: state.serviceInstalled && state.serviceEnabled ? 'cekai-link inspect' : state.serviceInstalled ? 'cekai-link service start' : 'cekai-link run' };
    } catch (error) {
      await writeUpdateState(configPath, { ...state, lastFailure: 'transition-unconfirmed' });
      throw error;
    }
  });
}

async function assertIdle(config: string, runtime: string, managed: boolean): Promise<void> {
  if ((await readPublicLinkRuntimeStatus(runtime))?.currentTask) throw new Error('任务正在执行或待恢复；先inspect，升级不会重复执行任务。');
  try {
    await lstat(`${config}.runtime.lock`);
    if (!managed) throw new Error('前台或未知进程仍持锁；先正常停止，不删除运行锁。');
    const owner = await readServiceOwner(config), lock = JSON.parse(await readFile(`${config}.runtime.lock`, 'utf8'));
    if (!owner || owner.pid !== lock.pid) throw new Error('运行进程归属未知；保留状态并inspect。');
    process.kill(owner.pid, 0);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
