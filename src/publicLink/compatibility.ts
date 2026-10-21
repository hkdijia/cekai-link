import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { parsePublicLinkCompatibility, readPublicSourceRuntimeIdentity } from './packageIdentity.js';
import { httpsServerUrl, type PublicLinkDigest } from './protocol.js';

const maximumBytes = 16 * 1024;

function centralOrigin(serverUrl: string): string {
  const url = new URL(httpsServerUrl(serverUrl));
  if (url.pathname !== '/') throw new Error('Central 地址必须为 HTTPS origin，不含路径');
  return url.origin;
}

/** Stable per confirmed origin and package; also resumes a download interrupted before pairing. */
export function downloadedCompatibilityPath(configPath: string, serverUrl: string, packageArtifactId: PublicLinkDigest): string {
  const originDigest = createHash('sha256').update(centralOrigin(serverUrl)).digest('hex');
  return path.join(path.dirname(configPath), 'compatibility', `${originDigest}-${packageArtifactId.slice(7)}.json`);
}

export async function downloadPublicLinkCompatibility(serverUrl: string, packageArtifactId: PublicLinkDigest,
  options: { readonly fetch?: typeof fetch; readonly timeoutMs?: number } = {}): Promise<unknown> {
  const url = new URL('/api/link/compatibility', centralOrigin(serverUrl));
  url.searchParams.set('packageArtifactId', packageArtifactId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await (options.fetch ?? fetch)(url, {
      method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal,
      headers: { accept: 'application/json' }
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      if (response.status === 404) throw new Error('Central 未提供此包的兼容材料（旧 Central 或包尚未批准）');
      if (response.status === 503) throw new Error('Central 正在切换或兼容事实不可用');
      throw new Error('Central 兼容材料请求未成功');
    }
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
      await response.body?.cancel();
      throw new Error('Central 兼容材料超过大小上限');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Central 兼容材料为空');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maximumBytes) throw new Error('Central 兼容材料超过大小上限');
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    let mapping: unknown;
    try {
      mapping = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      parsePublicLinkCompatibility(mapping, packageArtifactId);
    } catch { throw new Error('Central 兼容材料无效或不匹配当前安装包'); }
    return mapping;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Central 兼容材料读取超时');
    if (error instanceof Error && error.message.startsWith('Central ')) throw error;
    throw new Error('Central 兼容材料无法读取；请核对网络（不允许重定向）');
  } finally { clearTimeout(timer); }
}

/** Only validated metadata is atomically placed in Link-owned state, never in the package/workspace. */
export async function saveDownloadedCompatibility(input: {
  readonly filePath: string; readonly packageRoot: string; readonly workspaceRoot?: string; readonly mapping: unknown;
}): Promise<void> {
  const directory = path.dirname(input.filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Link compatibility directory must not be a symbolic link');
  const canonicalDirectory = await realpath(directory);
  for (const root of [input.packageRoot, input.workspaceRoot].filter((value): value is string => Boolean(value))) {
    const relative = path.relative(await realpath(root), canonicalDirectory);
    if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
      throw new Error('Link compatibility directory must remain outside the package and workspace');
    }
  }
  const temporary = path.join(directory, `.compatibility-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(input.mapping, null, 2)}\n`, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    readPublicSourceRuntimeIdentity(input.packageRoot, temporary);
    await rename(temporary, input.filePath);
  } finally { await rm(temporary, { force: true }); }
}
