import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_PACKAGE_FILES, publicSourcePackageFiles, parsePublicLinkCompatibility, readPublicSourceRuntimeIdentity, verifyPublicSourcePackage } from './packageIdentity.js';
import { createPublicLinkConfigStore } from './config.js';
import { readPublicLinkSnapshot } from './inspect.js';
import { createPublicLinkApi } from './api.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}` as const;

async function fixture() {
  const scratch = await mkdtemp(path.join(tmpdir(), 'public-source-identity-')); roots.push(scratch);
  const root = path.join(scratch, 'package');
  const hash = createHash('sha256');
  for (const file of SOURCE_PACKAGE_FILES) {
    const target = path.join(root, file); await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file === 'package.json' ? JSON.stringify({ name: '@cekaitech/cekai-link', version: '0.1.0',
      bin: { 'cekai-link': 'bin/cekai-link-source.cjs' }, cekaiLink: { packageFormat: 4 } }) : 'fixture\n');
    hash.update(file).update('\0').update(await readFile(target)).update('\0');
  }
  const descriptor = { schemaVersion: 1, packageVersion: '0.1.0', publicSourceRevision: 'a'.repeat(40), sourceDigest: digest('public-source'), treeDigest: `sha256:${hash.digest('hex')}` };
  const packageArtifactId = digest(JSON.stringify(descriptor));
  await writeFile(path.join(root, 'link-build.json'), JSON.stringify({ ...descriptor, kind: 'public-link-source-build', packageArtifactId, files: SOURCE_PACKAGE_FILES }));
  const mapping = { schemaVersion: 1, packageArtifactId, releaseId: digest('central-release'), sourceRevision: 'b'.repeat(40),
    protocolVersion: 1, contractDigest: digest('contract'), sourceLinkRoleDigest: digest('private-role'),
    sourceLinkComponentDigests: { mcp: digest('mcp'), schemas: digest('schemas'), skills: digest('skills') } };
  return { root, scratch, mapping, packageArtifactId };
}

async function refreshIdentity(root: string, files = publicSourcePackageFiles(root)) {
  const previous = JSON.parse(await readFile(path.join(root, 'link-build.json'), 'utf8'));
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(await readFile(path.join(root, file))).update('\0');
  const descriptor = { schemaVersion: 1, packageVersion: previous.packageVersion, publicSourceRevision: previous.publicSourceRevision, sourceDigest: previous.sourceDigest, treeDigest: `sha256:${hash.digest('hex')}` };
  await writeFile(path.join(root, 'link-build.json'), JSON.stringify({ ...descriptor, kind: previous.kind, packageArtifactId: digest(JSON.stringify(descriptor)), files }));
}

describe('independent public source identity', () => {
  it('retains the exact previous format for inspection without weakening current client startup or content checks', async () => {
    const { root } = await fixture();
    const updateModules = ['dist/publicLink/update.js', 'dist/publicLink/updatePackage.js', 'dist/publicLink/updateState.js'];
    for (const file of updateModules) await rm(path.join(root, file));
    const beforeUpdate = SOURCE_PACKAGE_FILES.filter(file => !updateModules.includes(file));
    await refreshIdentity(root, beforeUpdate);
    expect(verifyPublicSourcePackage(root, { allowPreviousInventory: true }).files).toEqual(beforeUpdate);
    const serviceModules = ['dist/publicLink/service.js', 'dist/publicLink/serviceFiles.js', 'dist/adapters/publicLinkService/native.js'];
    for (const file of serviceModules) await rm(path.join(root, file));
    const beforeService = beforeUpdate.filter(file => !serviceModules.includes(file));
    await refreshIdentity(root, beforeService);
    expect(() => verifyPublicSourcePackage(root)).toThrow('identity is invalid');
    expect(verifyPublicSourcePackage(root, { allowPreviousInventory: true }).files).toEqual(beforeService);
    const compatibilityModule = path.join(root, 'dist/publicLink/compatibility.js');
    await rm(compatibilityModule);
    await refreshIdentity(root, beforeService.filter(file => file !== 'dist/publicLink/compatibility.js'));
    const previous = JSON.parse(await readFile(path.join(root, 'link-build.json'), 'utf8'));
    expect(() => verifyPublicSourcePackage(root)).toThrow('identity is invalid');
    expect(verifyPublicSourcePackage(root, { allowPreviousInventory: true }).packageArtifactId).toBe(previous.packageArtifactId);
    await writeFile(path.join(root, 'dist/publicLink/api.js'), 'tampered');
    expect(() => verifyPublicSourcePackage(root, { allowPreviousInventory: true })).toThrow('runtime digest');
    await writeFile(path.join(root, 'dist/publicLink/api.js'), 'fixture\n');
    await writeFile(compatibilityModule, 'unreviewed module');
    expect(() => verifyPublicSourcePackage(root, { allowPreviousInventory: true })).toThrow('unreviewed runtime files');
  });

  it('prioritizes mapping then missing Codex before pairing on a clean installation', async () => {
    const { root, scratch, mapping } = await fixture();
    vi.stubEnv('CEKAI_LINK_SOURCE_PACKAGE_ROOT', root);
    vi.stubEnv('CEKAI_LINK_COMPATIBILITY_PATH', '');
    const configPath = path.join(scratch, 'config.json');
    const read = () => readPublicLinkSnapshot({ configPath, runtimePath: path.join(scratch, 'runtime.json'), codexInstallation: () => 'missing' });
    expect((await read()).nextAction.code).toBe('configure-compatibility');
    const mappingPath = path.join(scratch, 'compatibility.json');
    await writeFile(mappingPath, JSON.stringify(mapping));
    vi.stubEnv('CEKAI_LINK_COMPATIBILITY_PATH', mappingPath);
    expect((await read()).nextAction.code).toBe('install-codex');
    const readyToPair = await readPublicLinkSnapshot({ configPath, runtimePath: path.join(scratch, 'runtime.json'), codexInstallation: () => 'found' });
    expect(readyToPair.nextAction.code).toBe('pair-device');
  });

  it('uses the stored mapping in a fresh terminal, but revalidates it and honors explicit override', async () => {
    const { root, scratch, mapping } = await fixture();
    const mappingPath = path.join(scratch, 'compatibility.json');
    const configPath = path.join(scratch, 'config.json');
    vi.stubEnv('CEKAI_LINK_SOURCE_PACKAGE_ROOT', root);
    vi.stubEnv('CEKAI_LINK_PUBLIC_CONFIG_PATH', configPath);
    vi.stubEnv('CEKAI_LINK_COMPATIBILITY_PATH', '');
    await writeFile(mappingPath, JSON.stringify(mapping));
    await createPublicLinkConfigStore(configPath).save({ version: 1, serverUrl: 'http://127.0.0.1', credential: 'fixture', workerId: 'worker', deviceId: 'device', deviceName: 'fixture', compatibilityPath: mappingPath });
    expect(readPublicSourceRuntimeIdentity(root).sourceRevision).toBe(mapping.sourceRevision);
    const invalidOverride = path.join(scratch, 'wrong.json');
    await writeFile(invalidOverride, JSON.stringify({ ...mapping, packageArtifactId: digest('wrong') }));
    vi.stubEnv('CEKAI_LINK_COMPATIBILITY_PATH', invalidOverride);
    expect(() => readPublicSourceRuntimeIdentity(root)).toThrow('does not match');
    vi.stubEnv('CEKAI_LINK_COMPATIBILITY_PATH', '');
    await writeFile(mappingPath, JSON.stringify({ ...mapping, packageArtifactId: digest('other') }));
    expect(() => readPublicSourceRuntimeIdentity(root)).toThrow('does not match');
    expect((await readPublicLinkSnapshot({ configPath, codexInstallation: () => 'found' })).nextAction.code).toBe('configure-compatibility');
  });

  it('reports a safe startup diagnosis without paths, identities, credentials or provider guesses', async () => {
    const { root, scratch, mapping } = await fixture();
    const mappingPath = path.join(scratch, 'compatibility.json');
    const configPath = path.join(scratch, 'config.json'); const runtimePath = path.join(scratch, 'runtime.json');
    vi.stubEnv('CEKAI_LINK_SOURCE_PACKAGE_ROOT', root); vi.stubEnv('CEKAI_LINK_COMPATIBILITY_PATH', mappingPath);
    await writeFile(mappingPath, JSON.stringify(mapping));
    await createPublicLinkConfigStore(configPath).save({ version: 1, serverUrl: 'http://127.0.0.1', credential: 'secret-fixture', workerId: 'worker', deviceId: 'device', deviceName: 'fixture', compatibilityPath: mappingPath,
      workspace: { replicaId: 'replica', projectId: 'project', workspaceId: 'workspace', rootIdentity: digest('workspace'), rootDigest: 'root', canonicalRoot: scratch, os: 'macos', workspaceKind: 'folder' } });
    const api = { ...createPublicLinkApi(), readSnapshot: vi.fn(async () => ({ schemaVersion: 1 as const, conversationBinding: 'active' as const, activeBindingCount: 1, registeredProjectCount: 1, centralCompatibility: 'accepted' as const, dispatchReady: true })) };
    const read = () => readPublicLinkSnapshot({ configPath, runtimePath, api, codexInstallation: () => 'found' });
    await writeFile(runtimePath, JSON.stringify({ state: 'stopped', sequence: 1, pid: 2_147_483_647, updatedAt: new Date().toISOString(), lastError: 'Codex app-server could not start' }));
    expect((await read()).nextAction.code).toBe('diagnose-codex');
    await writeFile(runtimePath, JSON.stringify({ state: 'failed', sequence: 1, pid: 2_147_483_647, updatedAt: new Date().toISOString(), lastError: `${scratch} secret-fixture provider-unknown task-private` }));
    const snapshot = await read();
    expect(snapshot.runtime.lastFailure).toBe('runtime-failed');
    for (const forbidden of [scratch, 'secret-fixture', 'provider-unknown', 'task-private', 'lastError']) expect(JSON.stringify(snapshot)).not.toContain(forbidden);
  });
  it('verifies only source/build identity without a private release manifest', async () => {
    const { root, packageArtifactId } = await fixture();
    expect(verifyPublicSourcePackage(root)).toMatchObject({ publicSourceRevision: 'a'.repeat(40), packageArtifactId });
    expect(() => readPublicSourceRuntimeIdentity(root, '')).toThrow('mapping is required');
  });

  it('maps Central wire compatibility without pretending Central SHA is public source SHA', async () => {
    const { root, scratch, mapping, packageArtifactId } = await fixture();
    const file = path.join(scratch, 'compatibility.json'); await writeFile(file, JSON.stringify(mapping));
    expect(readPublicSourceRuntimeIdentity(root, file)).toMatchObject({ sourceRevision: 'b'.repeat(40), publicPackageArtifactId: packageArtifactId });
    expect(verifyPublicSourcePackage(root).publicSourceRevision).toBe('a'.repeat(40));
  });

  it('rejects wrong package mappings, extra fields and mappings packaged with source', async () => {
    const { root, mapping, packageArtifactId } = await fixture();
    expect(() => parsePublicLinkCompatibility({ ...mapping, packageArtifactId: digest('other') }, packageArtifactId)).toThrow('does not match');
    expect(() => parsePublicLinkCompatibility({ ...mapping, approval: true }, packageArtifactId)).toThrow('unsupported fields');
    expect(() => readPublicSourceRuntimeIdentity(root, path.join(root, 'compatibility.json'))).toThrow('outside');
  });

  it('rejects runtime tampering and private files added to dist', async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, 'dist/publicLink/api.js'), 'modified');
    expect(() => verifyPublicSourcePackage(root)).toThrow('runtime digest');
    await writeFile(path.join(root, 'dist/release-manifest.json'), '{}');
    expect(() => verifyPublicSourcePackage(root)).toThrow('unreviewed runtime files');
  });

  it('rejects missing component metadata and mappings hidden inside the package through an outside directory alias', async () => {
    const { root, scratch, mapping, packageArtifactId } = await fixture();
    expect(() => parsePublicLinkCompatibility({ ...mapping, sourceLinkComponentDigests: {} }, packageArtifactId)).toThrow();
    await writeFile(path.join(root, 'compatibility.json'), JSON.stringify(mapping));
    const alias = path.join(scratch, 'alias');
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => readPublicSourceRuntimeIdentity(root, path.join(alias, 'compatibility.json'))).toThrow('outside');
  });

  it('includes operator-supplied LICENSE/NOTICE in exact identity, and rejects legal-file tampering', async () => {
    const { root, packageArtifactId } = await fixture();
    await writeFile(path.join(root, 'LICENSE'), 'TEST FIXTURE ONLY — no license grant\n');
    await writeFile(path.join(root, 'NOTICE'), 'TEST FIXTURE ONLY\n');
    expect(() => verifyPublicSourcePackage(root)).toThrow('identity is invalid');
    await refreshIdentity(root);
    const result = verifyPublicSourcePackage(root);
    expect(result.files).toContain('LICENSE'); expect(result.files).toContain('NOTICE');
    expect(result.packageArtifactId).not.toBe(packageArtifactId);
    await writeFile(path.join(root, 'NOTICE'), 'tampered notice');
    expect(() => verifyPublicSourcePackage(root)).toThrow('runtime digest');
  });

  it('requires LICENSE for a declared public license without choosing a license for preview', async () => {
    const { root } = await fixture();
    const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ ...metadata, license: 'MIT' }));
    await refreshIdentity(root);
    expect(() => verifyPublicSourcePackage(root)).toThrow('declared license file');
  });
});
