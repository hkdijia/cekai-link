import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyPublicSourcePackage, type PublicSourceBuildIdentity } from './packageIdentity.js';

export const exactUpdateVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const maxArchive = 2 * 1024 * 1024;
const maxExpanded = 8 * 1024 * 1024;
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

/** User-invoked exact-version fetch only. No npm command, hooks, redirects or latest. */
export async function readUpdatePackage(target: string, fetchPort: typeof fetch = fetch): Promise<Buffer> {
  if (!exactUpdateVersion.test(target)) {
    if (!path.isAbsolute(target)) throw new Error('指定精确版本或可信安装包的绝对路径；不接受 latest/范围版本。');
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxArchive) throw new Error('升级安装包必须是大小受限的普通文件。');
    return readFile(target);
  }
  const metadata = JSON.parse((await boundedRead(`https://registry.npmjs.org/@cekaitech%2fcekai-link/${target}`, 256 * 1024, fetchPort)).toString('utf8'));
  if (metadata.name !== '@cekaitech/cekai-link' || metadata.version !== target || Object.keys(metadata.dependencies ?? {}).length
    || metadata.bundleDependencies !== undefined || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(metadata.dist?.integrity ?? '')) throw new Error('官方安装包元数据无效。');
  const url = new URL(metadata.dist.tarball);
  if (url.origin !== 'https://registry.npmjs.org' || !url.pathname.startsWith('/@cekaitech/cekai-link/-/') || url.search || url.hash || url.username || url.password) throw new Error('安装包来源不属于官方registry。');
  const bytes = await boundedRead(url.href, maxArchive, fetchPort);
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== metadata.dist.integrity) throw new Error('官方安装包摘要不匹配。');
  return bytes;
}

/** A small regular-file-only npm archive reader, before any package code executes. */
export function unpackUpdatePackage(bytes: Buffer): Map<string, Buffer> {
  if (bytes.length > maxArchive) throw new Error('安装包超过大小上限。');
  const tar = gunzipSync(bytes, { maxOutputLength: maxExpanded });
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) {
      if (tar.subarray(offset).some(byte => byte !== 0)) throw new Error('安装包包含无效尾部。');
      break;
    }
    const text = (start: number, length: number) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const number = (start: number, length: number) => {
      const value = text(start, length).trim();
      if (!/^[0-7]+$/.test(value)) throw new Error('安装包头部无效。');
      return parseInt(value, 8);
    };
    const checksum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (number(148, 8) !== checksum) throw new Error('安装包头部校验失败。');
    const name = text(0, 100), prefix = text(345, 155), size = number(124, 12);
    if (prefix || !name.startsWith('package/') || /[\\\x00-\x1f]/.test(name) || name.split('/').some(part => part === '..' || part === '.' || part === '')
      || !['0', '\0'].includes(String.fromCharCode(header[156]!)) || files.has(name.slice(8)) || files.size >= 64 || offset + size > tar.length) throw new Error('安装包包含非普通文件、重复项或越界路径。');
    const relative = name.slice(8);
    if (!/^(?:README\.md|LICENSE|NOTICE|package\.json|link-build\.json|bin\/cekai-link-source\.cjs|dist\/publicLink\/[A-Za-z]+\.js|dist\/adapters\/publicLinkService\/native\.js)$/.test(relative)) throw new Error('安装包文件不属于公开Link边界。');
    files.set(relative, Buffer.from(tar.subarray(offset, offset + size)));
    offset += Math.ceil(size / 512) * 512;
  }
  if (files.size < 5 || !files.has('link-build.json') || !files.has('package.json')) throw new Error('安装包不完整。');
  const build = JSON.parse(files.get('link-build.json')!.toString('utf8'));
  if (!Array.isArray(build.files) || JSON.stringify([...files.keys()].sort()) !== JSON.stringify([...build.files, 'link-build.json'].sort())) throw new Error('安装包清单与身份不匹配。');
  return files;
}

export async function prepareUpdatePackage(bytes: Buffer, store: string): Promise<{ root: string; build: PublicSourceBuildIdentity }> {
  const files = unpackUpdatePackage(bytes);
  await mkdir(store, { recursive: true, mode: 0o700 });
  const temporary = path.join(store, `.prepare-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    for (const [file, content] of files) {
      const target = path.join(temporary, file); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { flag: 'wx', mode: file.startsWith('bin/') ? 0o700 : 0o600 });
    }
    const build = verifyPublicSourcePackage(temporary, { allowPreviousInventory: true });
    const root = path.join(store, build.packageArtifactId.slice(7));
    try {
      await lstat(root);
      if (verifyPublicSourcePackage(root, { allowPreviousInventory: true }).packageArtifactId !== build.packageArtifactId) throw new Error('已保存版本身份不匹配。');
      return { root, build };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rename(temporary, root);
    await writeFile(`${root}.tgz`, bytes, { flag: 'wx', mode: 0o600 });
    return { root, build };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** Preserve an already verified current installation; no npm cache or old machine is required. */
export async function retainUpdatePackage(root: string, store: string): Promise<string> {
  const build = verifyPublicSourcePackage(root, { allowPreviousInventory: true });
  const target = path.join(store, build.packageArtifactId.slice(7));
  if (path.resolve(root) === target) return root;
  await mkdir(store, { recursive: true, mode: 0o700 });
  const temporary = path.join(store, `.retain-${randomUUID()}`); await mkdir(temporary);
  try {
    for (const name of [...build.files, 'link-build.json']) {
      const file = path.join(temporary, name); await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, await readFile(path.join(root, name)), { flag: 'wx', mode: 0o600 });
    }
    verifyPublicSourcePackage(temporary, { allowPreviousInventory: true });
    try { await lstat(target); verifyPublicSourcePackage(target, { allowPreviousInventory: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await rename(temporary, target); }
    return target;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export const updateArchiveDigest = (bytes: Buffer): string => `sha256:${sha(bytes)}`;

async function boundedRead(url: string, maximum: number, fetchPort: typeof fetch): Promise<Buffer> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetchPort(url, { redirect: 'error', credentials: 'omit', signal: controller.signal, headers: { accept: 'application/json, application/octet-stream' } });
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > maximum || !response.body) { await response.body?.cancel(); throw new Error('升级资料无法读取或超过大小上限。'); }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > maximum) throw new Error('升级资料超过大小上限。'); chunks.push(part.value); }
    } finally { await reader.cancel(); reader.releaseLock(); }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); }
}
