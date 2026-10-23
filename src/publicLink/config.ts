import { chmod, link, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
      await writePublicLinkFile(resolved, `${JSON.stringify(parsed, null, 2)}\n`);
    }
  };
}

/** Publish complete private bytes; exclusive creation never replaces an existing owner. */
export async function writePublicLinkFile(file: string, bytes: string, exclusive = false): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(bytes, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await chmod(temporary, 0o600);
    if (exclusive) await link(temporary, file);
    else await replacePublicLinkFile(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

/** Windows readers/scanners can briefly deny replace; never delete the old target. */
export async function replacePublicLinkFile(source: string, target: string, os: NodeJS.Platform = process.platform): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, target); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (os !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 7) throw error;
      await delay(Math.min(25 * 2 ** attempt, 200));
    }
  }
}

/** The synchronous package entry reads the same config as setup/inspect. */
export function storedPublicLinkCompatibilityPath(filePath = defaultPublicLinkConfigPath()): string | undefined {
  try { return parsePublicLinkConfig(JSON.parse(readFileSync(filePath, 'utf8'))).compatibilityPath; }
  catch (error) {
    if (isCode(error, 'ENOENT')) return undefined;
    throw new Error('Public Link configuration is invalid');
  }
}

export function defaultDeviceName(): string {
  const value = hostname().trim();
  return value || 'Cekai Link device';
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
