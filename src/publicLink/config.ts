import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir, hostname, platform } from 'node:os';
import path from 'node:path';
import { parsePublicLinkConfig, type PublicLinkConfig, type PublicLinkOs } from './protocol.js';

export interface PublicLinkConfigStore {
  readonly filePath: string;
  load(): Promise<PublicLinkConfig | undefined>;
  save(value: PublicLinkConfig): Promise<void>;
}

export function currentPublicLinkOs(): PublicLinkOs {
  if (platform() === 'win32') return 'windows';
  if (platform() === 'darwin') return 'macos';
  if (platform() === 'linux') return 'linux';
  throw new Error('Cekai Link supports Windows, macOS and Linux');
}

export function defaultPublicLinkConfigPath(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.CEKAI_LINK_PUBLIC_CONFIG_PATH?.trim();
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('Public Link config path must be absolute');
    return path.resolve(override);
  }
  const home = environment.HOME || environment.USERPROFILE || homedir();
  if (currentPublicLinkOs() === 'windows') {
    return path.win32.join(environment.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'CekaiTech', 'cekai-link-public', 'config.json');
  }
  if (currentPublicLinkOs() === 'linux') {
    return path.posix.join(environment.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'CekaiTech', 'cekai-link-public', 'config.json');
  }
  return path.posix.join(home.replaceAll('\\', '/'), 'Library', 'Application Support', 'CekaiTech', 'cekai-link-public', 'config.json');
}

export function defaultPublicLinkRuntimePath(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.CEKAI_LINK_PUBLIC_RUNTIME_PATH?.trim();
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('Public Link runtime path must be absolute');
    return path.resolve(override);
  }
  const home = environment.HOME || environment.USERPROFILE || homedir();
  if (currentPublicLinkOs() === 'windows') {
    return path.win32.join(environment.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'CekaiTech', 'cekai-link-public', 'runtime.json');
  }
  if (currentPublicLinkOs() === 'linux') {
    return path.posix.join(environment.XDG_STATE_HOME || path.posix.join(home, '.local', 'state'), 'CekaiTech', 'cekai-link-public', 'runtime.json');
  }
  return path.posix.join(home.replaceAll('\\', '/'), 'Library', 'Application Support', 'CekaiTech', 'cekai-link-public', 'runtime.json');
}

export function createPublicLinkConfigStore(filePath = defaultPublicLinkConfigPath()): PublicLinkConfigStore {
  const resolved = path.resolve(filePath);
  return {
    filePath: resolved,
    async load() {
      try { return parsePublicLinkConfig(JSON.parse(await readFile(resolved, 'utf8'))); }
      catch (error) {
        if (isCode(error, 'ENOENT')) return undefined;
        if (error instanceof Error && error.message.endsWith('is invalid')) throw new Error('Public Link configuration is invalid');
        throw new Error('Public Link configuration could not be read');
      }
    },
    async save(value) {
      const parsed = parsePublicLinkConfig(value);
      const directory = path.dirname(resolved);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(directory, `.config-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      try {
        await chmod(temporary, 0o600);
        await rename(temporary, resolved);
        await chmod(resolved, 0o600);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    }
  };
}

export function defaultDeviceName(): string {
  const value = hostname().trim();
  return value || 'Cekai Link device';
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
