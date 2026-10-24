import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicLinkConfigStore } from './config.js';
import { SOURCE_PACKAGE_FILES } from './packageIdentity.js';
import { runPublicLinkUpdate } from './update.js';
import { prepareUpdatePackage, readUpdatePackage, unpackUpdatePackage } from './updatePackage.js';
import { assertNoPendingUpdate, readUpdateState, selectedUpdateRoot, updatePaths } from './updateState.js';
import { readServiceRecord, serviceRecordPath, writeServiceJson } from './serviceFiles.js';
import { readPublicLinkSnapshot } from './inspect.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sha = (bytes: string | Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;

function archive(files: Map<string, Buffer>): Buffer {
  const chunks: Buffer[] = [];
  for (const [file, value] of files) {
    const header = Buffer.alloc(512); header.write(`package/${file}`); header.write('0000600\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(value.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136); header.fill(32, 148, 156); header[156] = 48;
    header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, value, Buffer.alloc((512 - value.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
async function packageFixture(root: string, version: string) {
  const files = new Map<string, Buffer>(); const hash = createHash('sha256');
  for (const name of SOURCE_PACKAGE_FILES) {
    const bytes = Buffer.from(name === 'package.json' ? JSON.stringify({ name: '@cekaitech/cekai-link', version, bin: { 'cekai-link': 'bin/cekai-link-source.cjs' }, cekaiLink: { packageFormat: 4 } }) : `fixture-${version}`);
    files.set(name, bytes); hash.update(name).update('\0').update(bytes).update('\0');
  }
  const descriptor = { schemaVersion: 1, packageVersion: version, publicSourceRevision: 'a'.repeat(40), sourceDigest: sha('source'), treeDigest: `sha256:${hash.digest('hex')}` };
  const artifact = sha(JSON.stringify(descriptor));
  files.set('link-build.json', Buffer.from(JSON.stringify({ ...descriptor, kind: 'public-link-source-build', packageArtifactId: artifact, files: SOURCE_PACKAGE_FILES })));
  for (const [name, bytes] of files) { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes); }
  return { files, artifact, bytes: archive(files) };
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'public-update-')); roots.push(root);
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const currentRoot = path.join(root, 'installed'), nextRoot = path.join(root, 'next');
  const current = await packageFixture(currentRoot, '1.0.0'), next = await packageFixture(nextRoot, '1.0.1');
  const tarball = path.join(root, 'target.tgz'); await writeFile(tarball, next.bytes);
  const configPath = path.join(root, 'config.json'), runtimePath = path.join(root, 'runtime.json');
  const config = { version: 1 as const, serverUrl: 'https://central.example.test', credential: 'secret', workerId: 'worker', deviceId: 'device', deviceName: 'fixture', compatibilityPath: path.join(root, 'old-map.json'),
    workspace: { replicaId: 'replica', projectId: 'project', workspaceId: 'workspace', rootIdentity: sha('workspace'), rootDigest: 'root', canonicalRoot: workspace, os: 'macos' as const, workspaceKind: 'folder' as const } };
  await createPublicLinkConfigStore(configPath).save(config);
  const mapping = (artifact: string) => ({ schemaVersion: 1, packageArtifactId: artifact, releaseId: sha('central'), sourceRevision: 'b'.repeat(40), protocolVersion: 1, contractDigest: sha('contract'), sourceLinkRoleDigest: sha('role'), sourceLinkComponentDigests: { mcp: sha('mcp'), schemas: sha('schema'), skills: sha('skills') } });
  await writeFile(config.compatibilityPath, JSON.stringify(mapping(current.artifact)));
  let approved = true;
  const fetchPort = vi.fn<typeof fetch>(async url => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/link/compatibility') return new Response(JSON.stringify(mapping(parsed.searchParams.get('packageArtifactId')!)), { status: approved ? 200 : 404 });
    return new Response(JSON.stringify({ ok: true, snapshot: { schemaVersion: 1, conversationBinding: 'active', activeBindingCount: 1, registeredProjectCount: 1, centralCompatibility: 'accepted', dispatchReady: true } }));
  });
  return { root, config, currentRoot, current, next, tarball, configPath, runtimePath, approve: (value: boolean) => { approved = value; }, options: { configPath, runtimePath, packageRoot: currentRoot, fetch: fetchPort } };
}

describe('explicit public Link upgrade', () => {
  it('switches an exact approved package and restores the complete old configuration identity without resetting heartbeat', async () => {
    const f = await fixture(); const before = await readFile(f.configPath, 'utf8');
    const runtime = JSON.stringify({ state: 'stopped', pid: process.pid, sequence: 123, updatedAt: new Date().toISOString() }); await writeFile(f.runtimePath, runtime);
    expect(await runPublicLinkUpdate({ action: 'apply', target: f.tarball, yes: true }, f.options)).toMatchObject({ ok: true, phase: 'completed', version: '1.0.1', nextAction: 'cekai-link run' });
    const updated = await createPublicLinkConfigStore(f.configPath).load(); expect(updated?.credential).toBe('secret'); expect(updated?.workspace).toEqual(f.config.workspace);
    expect(await readFile(f.runtimePath, 'utf8')).toBe(runtime); expect(await selectedUpdateRoot(f.configPath)).toContain(f.next.artifact.slice(7));
    expect(await runPublicLinkUpdate({ action: 'rollback', yes: true }, f.options)).toMatchObject({ ok: true, version: '1.0.0' });
    const restored = await createPublicLinkConfigStore(f.configPath).load(); const shape = JSON.parse(before); delete shape.compatibilityPath;
    const actual = { ...restored }; delete actual.compatibilityPath; expect(actual).toEqual(shape); expect(await readFile(f.runtimePath, 'utf8')).toBe(runtime);
  });

  it('rejects denied compatibility, busy/uncertain tasks and foreground locks before mutating the running installation', async () => {
    const f = await fixture(); const before = await readFile(f.configPath);
    f.approve(false); await expect(runPublicLinkUpdate({ action: 'apply', target: f.tarball, yes: true }, f.options)).rejects.toThrow('尚未批准');
    f.approve(true); await writeFile(f.runtimePath, JSON.stringify({ state: 'stopped', pid: process.pid, sequence: 1, currentTask: 'uncertain', updatedAt: new Date().toISOString() }));
    await expect(runPublicLinkUpdate({ action: 'apply', target: f.tarball, yes: true }, f.options)).rejects.toThrow('待恢复');
    await rm(f.runtimePath); await writeFile(`${f.configPath}.runtime.lock`, 'foreign');
    await expect(runPublicLinkUpdate({ action: 'apply', target: f.tarball, yes: true }, f.options)).rejects.toThrow('未知进程');
    expect(await readFile(f.configPath)).toEqual(before); expect(await readUpdateState(f.configPath)).toBeUndefined();
    expect(await readFile(`${f.configPath}.runtime.lock`, 'utf8')).toBe('foreign');
  });

  it('does nothing on declined confirmation and never accepts a same-version rebuild', async () => {
    const f = await fixture();
    expect(await runPublicLinkUpdate({ action: 'apply', target: f.tarball, yes: false }, { ...f.options, confirm: async () => false })).toMatchObject({ canceled: true, changed: false });
    expect(await readUpdateState(f.configPath)).toBeUndefined(); expect(await selectedUpdateRoot(f.configPath)).toBeUndefined();
    const same = await packageFixture(path.join(f.root, 'same'), '1.0.0');
    const modified = new Map(same.files); modified.set('README.md', Buffer.from('different'));
    // Corruption must fail identity before the version comparison or any mutation.
    await writeFile(f.tarball, archive(modified));
    await expect(runPublicLinkUpdate({ action: 'apply', target: f.tarball, yes: true }, f.options)).rejects.toThrow('digest');
  });

  it.each(['stopped', 'switched', 'starting'] as const)('resumes an interruption at %s with the same target and retains its backup', async phase => {
    const f = await fixture();
    await expect(runPublicLinkUpdate({ action: 'apply', target: f.tarball, yes: true }, { ...f.options, afterPhase: async value => { if (value === phase) throw new Error('interrupt'); } })).rejects.toThrow('interrupt');
    const state = (await readUpdateState(f.configPath))!; const backup = await readFile(state.backupPath);
    await expect(assertNoPendingUpdate(f.configPath)).rejects.toThrow('resume');
    vi.stubEnv('CEKAI_LINK_SOURCE_PACKAGE_ROOT', f.currentRoot);
    expect((await readPublicLinkSnapshot({ configPath: f.configPath, runtimePath: f.runtimePath, codexInstallation: () => 'found',
      api: { readSnapshot: async () => { throw new Error('offline'); } } as never })).nextAction.code).toBe('resume-update');
    expect(await runPublicLinkUpdate({ action: 'resume', yes: true }, f.options)).toMatchObject({ ok: true, phase: 'completed' });
    expect(await readFile(state.backupPath)).toEqual(backup); expect((await readUpdateState(f.configPath))?.token).toBe(state.token);
  });

  it('can explicitly recover an interrupted stopped transition to the old package when Central approves it', async () => {
    const f = await fixture();
    await expect(runPublicLinkUpdate({ action: 'apply', target: f.tarball, yes: true }, { ...f.options, afterPhase: async phase => { if (phase === 'stopped') throw new Error('interrupt'); } })).rejects.toThrow('interrupt');
    expect(await runPublicLinkUpdate({ action: 'rollback', yes: true }, f.options)).toMatchObject({ ok: true, version: '1.0.0', phase: 'completed' });
  });

  it('requires fresh old-version Central approval for rollback and restores a disabled service without starting it', async () => {
    const f = await fixture();
    await writeServiceJson(serviceRecordPath(f.configPath), { version: 1, configPath: f.configPath, runtimePath: f.runtimePath, nodePath: process.execPath,
      entryPath: path.join(f.currentRoot, 'bin/cekai-link-source.cjs'), packageArtifactId: f.current.artifact, home: f.root, searchPath: 'fixture', enabled: false });
    const calls: string[][] = [];
    const invoke = async (root: string, args: readonly string[]) => {
      calls.push([...args]);
      if (args[1] === 'uninstall') await rm(serviceRecordPath(f.configPath));
      else await writeServiceJson(serviceRecordPath(f.configPath), { version: 1, configPath: f.configPath, runtimePath: f.runtimePath, nodePath: process.execPath,
        entryPath: path.join(root, 'bin/cekai-link-source.cjs'), packageArtifactId: `sha256:${path.basename(root)}`, home: f.root, searchPath: 'fixture', enabled: false });
    };
    await runPublicLinkUpdate({ action: 'apply', target: f.tarball, yes: true }, { ...f.options, invoke });
    expect(calls).toContainEqual(['service', 'install', '--disabled']); expect((await readServiceRecord(f.configPath))?.enabled).toBe(false);
    const pointer = await selectedUpdateRoot(f.configPath); f.approve(false);
    await expect(runPublicLinkUpdate({ action: 'rollback', yes: true }, { ...f.options, invoke })).rejects.toThrow('尚未批准');
    expect(await selectedUpdateRoot(f.configPath)).toBe(pointer);
  });

  it('does not extract links, traversals, duplicate or corrupt content and bounds exact-version downloads', async () => {
    const f = await fixture(); expect(unpackUpdatePackage(f.next.bytes).size).toBe(SOURCE_PACKAGE_FILES.length + 1);
    for (const name of ['../outside', 'dist/private.js', 'config.json']) await expect(prepareUpdatePackage(archive(new Map([[name, Buffer.from('bad')]])), updatePaths(f.configPath).packages)).rejects.toThrow();
    const bad = Buffer.from(f.next.bytes); bad[10] = bad[10]! ^ 1; expect(() => unpackUpdatePackage(bad)).toThrow();
    await expect(readUpdatePackage('latest')).rejects.toThrow('精确版本');
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ name: '@cekaitech/cekai-link', version: '1.0.1', dependencies: { forbidden: '1' } })));
    await expect(readUpdatePackage('1.0.1', request)).rejects.toThrow('元数据'); expect(request).toHaveBeenCalledOnce();
  });
});
