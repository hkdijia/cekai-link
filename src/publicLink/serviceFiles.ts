import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { writePublicLinkFile } from './config.js';

export interface PublicLinkServiceRecord {
  readonly version: 1;
  readonly configPath: string;
  readonly runtimePath: string;
  readonly nodePath: string;
  readonly entryPath: string;
  readonly packageArtifactId: string;
  readonly home: string;
  readonly searchPath: string;
  readonly codexHome?: string;
  readonly codexExecutable?: string;
  readonly appData?: string;
  readonly localAppData?: string;
  readonly compatibilityPath?: string;
  readonly enabled: boolean;
}
export interface PublicLinkServiceOwner { readonly pid: number; readonly token: string; readonly bootId?: string; readonly birthId?: string }
export const serviceRecordPath = (configPath: string): string => `${configPath}.service.json`;
export const serviceOwnerPath = (configPath: string): string => `${configPath}.service-owner.json`;
export const publicLinkServiceId = (configPath: string): string => `cekai-link-public-${createHash('sha256').update(configPath).digest('hex').slice(0, 16)}`;

export async function readServiceRecord(configPath: string, filePath = serviceRecordPath(configPath)): Promise<PublicLinkServiceRecord | undefined> {
  const value = await readServiceJson(filePath);
  if (!value) return undefined;
  const record = value as unknown as PublicLinkServiceRecord;
  const required = ['version', 'configPath', 'runtimePath', 'nodePath', 'entryPath', 'packageArtifactId', 'home', 'searchPath', 'enabled'];
  const optional = ['codexHome', 'codexExecutable', 'appData', 'localAppData', 'compatibilityPath'] as const;
  if (required.some(key => !(key in value)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))
    || record.version !== 1 || record.configPath !== configPath || typeof record.enabled !== 'boolean'
    || typeof record.packageArtifactId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(record.packageArtifactId)
    || typeof record.searchPath !== 'string' || !record.searchPath || unsafe(record.searchPath)) throw new Error('Link service registration is invalid; preserve it and inspect before recovery');
  for (const value of [record.configPath, record.runtimePath, record.nodePath, record.entryPath, record.home,
    ...optional.filter(key => key in record).map(key => record[key])]) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || unsafe(value)) throw new Error('Link service paths are invalid');
  }
  return record;
}

export async function readServiceOwner(configPath: string): Promise<PublicLinkServiceOwner | undefined> {
  const value = await readServiceJson(serviceOwnerPath(configPath));
  if (!value) return undefined;
  if (!('pid' in value) || !('token' in value) || Object.keys(value).some(key => !['pid', 'token', 'bootId', 'birthId'].includes(key)) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
    || typeof value.token !== 'string' || !/^[a-f0-9-]{36}$/.test(value.token)
    || value.bootId !== undefined && (typeof value.bootId !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(value.bootId))
    || value.birthId !== undefined && (typeof value.birthId !== 'string' || !/^\d{8,30}$/.test(value.birthId))) throw new Error('Link service process record is invalid; preserve it for recovery');
  return value as unknown as PublicLinkServiceOwner;
}

/** Shared only by service registration/stop intent; credentials stay in the existing config. */
export async function writeServiceJson(file: string, value: unknown, exclusive = false): Promise<void> {
  await writePublicLinkFile(file, `${JSON.stringify(value)}\n`, exclusive);
}

export async function withServiceLock<T>(configPath: string, action: () => Promise<T>): Promise<T> {
  const lock = `${serviceRecordPath(configPath)}.lock`;
  const token = randomUUID();
  try { await writeServiceJson(lock, { pid: process.pid, token }, true); }
  catch { throw new Error('Another service operation or interrupted service lock exists; inspect before retrying'); }
  try { return await action(); }
  finally {
    if ((await readServiceJson(lock))?.token === token) await rm(lock);
  }
}

export async function readServiceJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const details = await lstat(file);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 64 * 1024
      || (process.platform !== 'win32' && ((details.mode & 0o077) !== 0 || (process.getuid && details.uid !== process.getuid())))) throw new Error('invalid');
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Link service file is invalid; preserve it and inspect before recovery');
  }
}
function unsafe(value: string): boolean { return /[\x00-\x1f\x7f]/.test(value); }
