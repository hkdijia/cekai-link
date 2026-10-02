import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createPublicLinkApi } from './api.js';
import { defaultDeviceName, currentPublicLinkOs, type PublicLinkConfigStore } from './config.js';
import { readPublicLinkSnapshot } from './inspect.js';
import { httpsServerUrl, type PublicLinkRuntimeIdentity } from './protocol.js';
import { validatePublicLinkWorkspace } from './workspace.js';

export interface PublicLinkSetupPorts {
  readonly config: PublicLinkConfigStore;
  readonly ask: (prompt: string, secret?: boolean) => Promise<string | undefined>;
  readonly output: (value: string) => void;
  readonly identity?: PublicLinkRuntimeIdentity;
}

export async function runPublicLinkSetup(input: PublicLinkSetupPorts): Promise<void> {
  let config = await input.config.load();
  if (!config) {
    const server = (await input.ask('Central HTTPS 地址（留空退出）：'))?.trim();
    if (!server) return input.output('尚未配对；下次运行 setup 可以继续。');
    const serverUrl = httpsServerUrl(server);
    const code = (await input.ask('设备配对码（输入不回显，留空退出）：', true))?.trim();
    if (!code) return input.output('尚未配对；请取得有效配对码后重新运行 setup。');
    const deviceName = (await input.ask(`设备名称（默认 ${defaultDeviceName()}）：`))?.trim() || defaultDeviceName();
    const paired = await createPublicLinkApi().pair(serverUrl, code, deviceName, input.identity);
    config = { version: 1, serverUrl, credential: paired.credential, workerId: paired.workerId, deviceId: paired.deviceId, deviceName };
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
    const registered = await createPublicLinkApi().registerWorkspace(config.serverUrl, config.credential, workspace);
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
