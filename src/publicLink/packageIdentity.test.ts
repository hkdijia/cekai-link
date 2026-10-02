import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SOURCE_PACKAGE_FILES, publicSourcePackageFiles, parsePublicLinkCompatibility, readPublicSourceRuntimeIdentity, verifyPublicSourcePackage } from './packageIdentity.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
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

async function refreshIdentity(root: string) {
  const previous = JSON.parse(await readFile(path.join(root, 'link-build.json'), 'utf8'));
  const files = publicSourcePackageFiles(root);
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(await readFile(path.join(root, file))).update('\0');
  const descriptor = { schemaVersion: 1, packageVersion: previous.packageVersion, publicSourceRevision: previous.publicSourceRevision, sourceDigest: previous.sourceDigest, treeDigest: `sha256:${hash.digest('hex')}` };
  await writeFile(path.join(root, 'link-build.json'), JSON.stringify({ ...descriptor, kind: previous.kind, packageArtifactId: digest(JSON.stringify(descriptor)), files }));
}

describe('independent public source identity', () => {
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
