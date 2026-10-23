import { createPublicLinkApi } from './api.js';
import { createPublicLinkConfigStore } from './config.js';
import { readPublicLinkSnapshot } from './inspect.js';
import { createPublicLinkRuntime, readPublicLinkRuntimeIdentity } from './runtime.js';
import { askPublicLinkQuestion, runPublicLinkSetup } from './setup.js';
import { assertIdentifier, httpsServerUrl } from './protocol.js';
import { validatePublicLinkWorkspace } from './workspace.js';
import { verifyPublicSourcePackage } from './packageIdentity.js';
import { operatePublicLinkService, runPublicLinkServiceHost, type PublicLinkServiceAction } from './service.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

export type PublicLinkCommand =
  | { readonly command: 'help' | 'version' }
  | { readonly command: 'inspect'; readonly json: boolean }
  | { readonly command: 'setup' }
  | { readonly command: 'pair'; readonly stdinCode: boolean; readonly serverUrl: string }
  | { readonly command: 'workspace-add'; readonly directory: string }
  | { readonly command: 'service'; readonly action: PublicLinkServiceAction }
  | { readonly command: 'service-host'; readonly configPath: string }
  | { readonly command: 'run' };

const usage = 'Usage: cekai-link setup | run | inspect [--json] | service <install|start|status|stop|uninstall> | --help | --version\n运行 cekai-link --help 查看全部命令和首次接入步骤。';
const help = [
  'Cekai Link — 本机工作区只读问答', '',
  '常用命令：',
  '  cekai-link setup             配对设备并登记自己选择的工作区；中断后可重新运行',
  '  cekai-link run               前台运行 Link，保持终端打开；Ctrl+C 正常停止',
  '  cekai-link inspect [--json]  查看状态和唯一下一步；status / doctor 为同一入口',
  '  cekai-link service install  可选：后台运行并在当前用户登录后启动；先正常停止前台 run',
  '  cekai-link service status   查看用户级服务；start / stop / uninstall 用于启停或移除',
  '  cekai-link --version         查看安装包版本和源码身份',
  '  cekai-link --help            查看此帮助（也可使用 help / -h）', '',
  '首次接入：先确认本机 Codex 可独立问答 → setup → run → 在目标聊天显式绑定设备和工作区。',
  '设备配对、工作区登记和聊天绑定分别完成；普通问题无需 /agent。', '',
  '高级入口：',
  '  cekai-link pair --server <https-url> [--code-stdin]',
  '  cekai-link workspace add --path <absolute-path>',
  '配对码使用隐藏输入或可信管道，不放入命令参数。', '',
  '帮助和版本查询无需配对，不读取个人 Link 配置或启动问答。',
  '接入指引：https://github.com/hkdijia/cekai-link#中文接入指引', ''
].join('\n');

export function parsePublicLinkArgs(argv: readonly string[]): PublicLinkCommand {
  if (argv.length === 0 || (argv.length === 1 && ['help', '--help', '-h'].includes(argv[0]!))) return { command: 'help' };
  if (argv.length === 1 && ['--version', '-v'].includes(argv[0]!)) return { command: 'version' };
  if ((argv[0] === 'inspect' || argv[0] === 'status' || argv[0] === 'doctor')
    && (argv.length === 1 || (argv.length === 2 && argv[1] === '--json'))) return { command: 'inspect', json: argv.length === 2 };
  if (argv[0] === 'setup' && argv.length === 1) return { command: 'setup' };
  if (argv[0] === 'run' && argv.length === 1) return { command: 'run' };
  if (argv[0] === 'service' && argv.length === 2 && ['install', 'start', 'status', 'stop', 'uninstall'].includes(argv[1]!)) return { command: 'service', action: argv[1] as PublicLinkServiceAction };
  if (argv[0] === 'service' && argv[1] === 'host' && argv[2] === '--config' && argv.length === 4 && path.isAbsolute(argv[3]!)) return { command: 'service-host', configPath: path.resolve(argv[3]!) };
  if (argv[0] === 'pair' && argv[1] === '--server' && (argv.length === 3 || (argv.length === 4 && argv[3] === '--code-stdin'))) {
    return { command: 'pair', stdinCode: argv.length === 4, serverUrl: httpsServerUrl(argv[2]) };
  }
  if (argv[0] === 'workspace' && argv[1] === 'add' && argv.length === 4 && argv[2] === '--path') return { command: 'workspace-add', directory: argv[3] };
  throw new Error(usage);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = parsePublicLinkArgs(argv);
  if (command.command === 'help') {
    process.stdout.write(help);
    return;
  }
  if (command.command === 'version') {
    const root = process.env.CEKAI_LINK_SOURCE_PACKAGE_ROOT;
    if (!root) throw new Error('安装包版本身份不可用；请从已安装的 cekai-link 入口运行 --version。');
    const identity = verifyPublicSourcePackage(root);
    process.stdout.write(`Cekai Link ${identity.packageVersion}\nsource ${identity.publicSourceRevision}\n`);
    return;
  }
  if (command.command === 'service-host') {
    try { await runPublicLinkServiceHost(command.configPath); }
    catch { process.exitCode = 1; } // Diagnose through inspect; never send raw failures to native journals.
    return;
  }
  if (command.command === 'service') {
    const result = await operatePublicLinkService(command.action);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const config = createPublicLinkConfigStore();
  if (command.command === 'inspect') {
    const snapshot = await readPublicLinkSnapshot({ configPath: config.filePath });
    process.stdout.write(command.json ? `${JSON.stringify(snapshot)}\n` : formatSnapshot(snapshot));
    return;
  }
  if (command.command === 'setup') {
    await runPublicLinkSetup({ config, resolveIdentity: (mappingPath) => readPublicLinkRuntimeIdentity(undefined, mappingPath),
      ask: askPublicLinkQuestion, output: (value) => process.stdout.write(`${value}\n`) });
    return;
  }
  const identity = readPublicLinkRuntimeIdentity();
  if (command.command === 'pair') {
    const existing = await config.load();
    const code = command.stdinCode ? await readPairingCodeFromStdin() : await askPublicLinkQuestion('设备配对码（输入不回显）：', true);
    const paired = await createPublicLinkApi().pair(command.serverUrl, assertIdentifier(code?.trim(), 'pairing code'), existing?.deviceName ?? 'Cekai Link device', identity);
    const compatibilityPath = process.env.CEKAI_LINK_COMPATIBILITY_PATH?.trim() || existing?.compatibilityPath;
    await config.save({ version: 1, serverUrl: command.serverUrl, credential: paired.credential, workerId: paired.workerId, deviceId: paired.deviceId, deviceName: existing?.deviceName ?? 'Cekai Link device', ...(existing?.workspace ? { workspace: existing.workspace } : {}), ...(compatibilityPath ? { compatibilityPath } : {}) });
    process.stdout.write(JSON.stringify({ ok: true, paired: true, workerId: paired.workerId, deviceId: paired.deviceId }) + '\n');
    return;
  }
  if (command.command === 'workspace-add') {
    const current = await config.load();
    if (!current) throw new Error('Cekai Link is not paired; run pair or setup first');
    const validated = await validatePublicLinkWorkspace(command.directory);
    const registered = await createPublicLinkApi().registerWorkspace(current.serverUrl, current.credential, validated);
    await config.save({ ...current, workspace: { ...validated, ...registered } });
    process.stdout.write(JSON.stringify({ ok: true, registered: true, projectId: registered.projectId, replicaId: registered.replicaId }) + '\n');
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { await createPublicLinkRuntime({ identity }).serve(controller.signal); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

async function readPairingCodeFromStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('Use setup or hidden terminal input; --code-stdin requires a trusted input pipe');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk.toString('utf8');
    if (input.length > 258) throw new Error('Pairing code input is invalid');
  }
  return assertIdentifier(input.replace(/\r?\n$/, ''), 'pairing code');
}

function formatSnapshot(snapshot: Awaited<ReturnType<typeof readPublicLinkSnapshot>>): string {
  return [
    'Cekai Link',
    `状态：${snapshot.overall}`,
    `配对：${snapshot.setup.pairing}`,
    `工作区：${snapshot.setup.workspaceRegistration}`,
    `会话绑定：${snapshot.setup.conversationBinding}`,
    `运行：${snapshot.runtime.launcher} / 引擎 ${snapshot.runtime.engine}`,
    `版本：${snapshot.release.publicSourceRevision ?? snapshot.release.runningRevision ?? '不可用'} / artifact ${snapshot.release.artifactIntegrity}`,
    `Central：${snapshot.release.centralCompatibility}`,
    `下一步：${snapshot.nextAction.label}`,
    `原因：${snapshot.nextAction.reason}`
  ].join('\n') + '\n';
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'cekai-link failed'}\n`);
    process.exitCode = 1;
  });
}
