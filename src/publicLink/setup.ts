import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createPublicLinkApi, type PublicLinkApi } from './api.js';
import { defaultDeviceName, currentPublicLinkOs, type PublicLinkConfigStore } from './config.js';
import { readPublicLinkSnapshot } from './inspect.js';
import { httpsServerUrl, type PublicLinkRuntimeIdentity } from './protocol.js';
import { validatePublicLinkWorkspace } from './workspace.js';
import { readPublicCodexInstallation } from './codex.js';
import { readPublicSourceRuntimeIdentity, verifyPublicSourcePackage } from './packageIdentity.js';
import { downloadPublicLinkCompatibility, downloadedCompatibilityPath, saveDownloadedCompatibility } from './compatibility.js';

export interface PublicLinkSetupPorts {
  readonly config: PublicLinkConfigStore;
  readonly ask: (prompt: string, secret?: boolean) => Promise<string | undefined>;
  readonly output: (value: string) => void;
  readonly identity?: PublicLinkRuntimeIdentity;
  readonly resolveIdentity?: (mappingPath?: string) => PublicLinkRuntimeIdentity | undefined;
  readonly codexInstallation?: () => 'found' | 'missing';
  readonly api?: PublicLinkApi;
  readonly fetch?: typeof fetch;
}

export async function runPublicLinkSetup(input: PublicLinkSetupPorts): Promise<void> {
  let config = await input.config.load();
  const api = input.api ?? createPublicLinkApi();
  const packageRoot = process.env.CEKAI_LINK_SOURCE_PACKAGE_ROOT?.trim();
  const build = packageRoot ? verifyPublicSourcePackage(packageRoot) : undefined;
  const explicitPath = process.env.CEKAI_LINK_COMPATIBILITY_PATH?.trim();
  let compatibilityPath = explicitPath || config?.compatibilityPath;
  const resolveIdentity = (mapping?: string) => input.resolveIdentity ? input.resolveIdentity(mapping)
    : packageRoot ? readPublicSourceRuntimeIdentity(packageRoot, mapping) : input.identity;
  let identity: PublicLinkRuntimeIdentity | undefined;
  if (compatibilityPath) {
    try { identity = resolveIdentity(compatibilityPath); }
    catch (error) {
      if (explicitPath) throw error;
      input.output('已保存的兼容文件不可用于当前包；保留原文件，尝试取得匹配材料。');
      compatibilityPath = undefined;
    }
  }
  if ((input.codexInstallation ?? readPublicCodexInstallation)() === 'missing') {
    return input.output('尚未找到本机 Codex CLI；请先单独安装并确认原生 Codex 问答可用，再重新运行 cekai-link setup。Link 不代装或登录 Codex。');
  }
  let serverUrl = config?.serverUrl;
  if (!serverUrl) {
    const server = (await input.ask('可信 Central HTTPS 地址（留空退出）：'))?.trim();
    if (!server) return input.output('尚未配对；下次运行 setup 可以继续。');
    serverUrl = httpsServerUrl(server);
  }
  if (build && packageRoot && !compatibilityPath) {
    const ownedPath = downloadedCompatibilityPath(input.config.filePath, serverUrl, build.packageArtifactId);
    try { identity = resolveIdentity(ownedPath); compatibilityPath = ownedPath; }
    catch { /* No usable saved download; retain it until a replacement is validated. */ }
    if (!compatibilityPath) {
      try {
        const mapping = await downloadPublicLinkCompatibility(serverUrl, build.packageArtifactId, { fetch: input.fetch });
        await saveDownloadedCompatibility({ filePath: ownedPath, packageRoot, workspaceRoot: config?.workspace?.canonicalRoot, mapping });
        identity = resolveIdentity(ownedPath);
        compatibilityPath = ownedPath;
        input.output('已获取并校验当前安装包的兼容材料。');
      } catch (error) {
        input.output(error instanceof Error ? error.message : 'Central 兼容材料获取失败。');
        compatibilityPath = (await input.ask('离线/旧 Central：部署方兼容文件绝对路径（留空退出，稍后重试）：'))?.trim();
        if (!compatibilityPath) return input.output('未消耗配对码；请向部署方取得匹配文件后重新运行 setup。');
        identity = resolveIdentity(compatibilityPath);
      }
    }
  }
  if (!build && !compatibilityPath) identity = resolveIdentity();
  if (config && compatibilityPath && config.compatibilityPath !== compatibilityPath) {
    config = { ...config, compatibilityPath };
    await input.config.save(config);
  }
  if (!config) {
    const code = (await input.ask('设备配对码（输入不回显，留空退出）：', true))?.trim();
    if (!code) return input.output('尚未配对；请取得有效配对码后重新运行 setup。');
    const deviceName = (await input.ask(`设备名称（默认 ${defaultDeviceName()}）：`))?.trim() || defaultDeviceName();
    const paired = await api.pair(serverUrl, code, deviceName, identity);
    config = { version: 1, serverUrl, credential: paired.credential, workerId: paired.workerId, deviceId: paired.deviceId, deviceName,
      ...(compatibilityPath ? { compatibilityPath } : {}) };
    await input.config.save(config);
    input.output('设备配对成功。');
  }
  if (!config.workspace) {
    const directory = (await input.ask('本机工作区绝对路径（留空稍后登记）：'))?.trim();
    if (!directory) return input.output('工作区尚未登记；下次运行 setup 可以继续。');
    const workspace = await validatePublicLinkWorkspace(directory, currentPublicLinkOs());
    if ((await input.ask(`确认登记此本机工作区？${workspace.canonicalRoot} [y/N]：`))?.trim().toLowerCase() !== 'y') {
      return input.output('未登记工作区；没有更改现有配置。');
    }
    const registered = await api.registerWorkspace(config.serverUrl, config.credential, workspace);
    config = { ...config, workspace: { ...workspace, ...registered } };
    await input.config.save(config);
    input.output('工作区登记成功。');
  }
  const snapshot = await readPublicLinkSnapshot({ configPath: input.config.filePath });
  input.output(snapshot.overall === 'ready'
    ? 'Link 已就绪，可在已绑定会话发送自然语言问题。'
    : `设置已保存；下一步：${snapshot.nextAction.label}。运行 cekai-link inspect 查看状态。`);
}

export async function askPublicLinkQuestion(prompt: string, secret = false): Promise<string | undefined> {
  if (!secret) {
    const terminal = createInterface({ input: stdin, output: stdout });
    try { return await terminal.question(prompt); }
    catch { return undefined; }
    finally { terminal.close(); }
  }
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') throw new Error('配对码只能从交互式终端安全输入');
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true); stdin.resume(); stdout.write(prompt);
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      let value = '';
      const finish = (result?: string) => { stdin.off('data', receive); resolve(result); };
      const receive = (chunk: Buffer | string) => {
        for (const character of chunk.toString('utf8')) {
          if (character === '\r' || character === '\n') return finish(value);
          if (character === '\u0003') { stdin.off('data', receive); return reject(new Error('setup canceled')); }
          if (character === '\u0004') return finish(undefined);
          if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
          else if (character >= ' ') value += character;
        }
      };
      stdin.on('data', receive);
    });
  } finally {
    stdin.setRawMode(Boolean(wasRaw)); stdin.pause(); stdout.write('\n');
  }
}
