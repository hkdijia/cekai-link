import { createPublicLinkApi } from './api.js';
import { createPublicLinkConfigStore } from './config.js';
import { readPublicLinkSnapshot } from './inspect.js';
import { createPublicLinkRuntime, readPublicLinkRuntimeIdentity } from './runtime.js';
import { askPublicLinkQuestion, runPublicLinkSetup } from './setup.js';
import { assertIdentifier, httpsServerUrl } from './protocol.js';
import { validatePublicLinkWorkspace } from './workspace.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

export type PublicLinkCommand =
  | { readonly command: 'inspect'; readonly json: boolean }
  | { readonly command: 'setup' }
  | { readonly command: 'pair'; readonly stdinCode: boolean; readonly serverUrl: string }
  | { readonly command: 'workspace-add'; readonly directory: string }
  | { readonly command: 'run' };

const usage = 'Usage: cekai-link inspect [--json] | setup | pair --server <https-url> [--code-stdin] | workspace add --path <absolute-path> | run';

export function parsePublicLinkArgs(argv: readonly string[]): PublicLinkCommand {
  if (argv[0] === 'inspect' || argv[0] === 'status' || argv[0] === 'doctor') return { command: 'inspect', json: argv.includes('--json') };
  if (argv[0] === 'setup' && argv.length === 1) return { command: 'setup' };
  if (argv[0] === 'run' && argv.length === 1) return { command: 'run' };
  if (argv[0] === 'pair' && argv[1] === '--server' && (argv.length === 3 || (argv.length === 4 && argv[3] === '--code-stdin'))) {
    return { command: 'pair', stdinCode: argv.length === 4, serverUrl: httpsServerUrl(argv[2]) };
  }
  if (argv[0] === 'workspace' && argv[1] === 'add' && argv.length === 4 && argv[2] === '--path') return { command: 'workspace-add', directory: argv[3] };
  throw new Error(usage);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = parsePublicLinkArgs(argv);
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
