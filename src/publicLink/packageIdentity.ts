import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { storedPublicLinkCompatibilityPath } from './config.js';
import { digestValue, objectValue, type PublicLinkDigest, type PublicLinkRuntimeIdentity } from './protocol.js';

export const SOURCE_PACKAGE_FILES = [
  'README.md', 'bin/cekai-link-source.cjs', 'package.json',
  ...['api', 'cli', 'codex', 'compatibility', 'config', 'inspect', 'packageIdentity', 'protocol', 'runtime', 'setup', 'workspace']
    .map((name) => `dist/publicLink/${name}.js`)
].sort();

/** Optional legal files are hashed, never invented or granted by the builder. */
export function publicSourcePackageFiles(root: string): string[] {
  const legalFiles = ['LICENSE', 'NOTICE'].filter((file) => {
    try { regularFile(path.join(root, file)); return true; }
    catch (error) { if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false; throw error; }
  });
  return [...SOURCE_PACKAGE_FILES, ...legalFiles].sort();
}

export interface PublicSourceBuildIdentity {
  readonly schemaVersion: 1;
  readonly kind: 'public-link-source-build';
  readonly packageVersion: string;
  readonly publicSourceRevision: string;
  readonly sourceDigest: PublicLinkDigest;
  readonly treeDigest: PublicLinkDigest;
  readonly packageArtifactId: PublicLinkDigest;
  readonly files: readonly string[];
}

/** Content integrity is not a publisher signature or Central authorization. */
export function verifyPublicSourcePackage(root: string, options: { readonly allowPreviousInventory?: boolean } = {}): PublicSourceBuildIdentity {
  const currentFiles = publicSourcePackageFiles(root);
  const value = objectValue(readJson(path.join(root, 'link-build.json')), 'source build identity');
  exactKeys(value, ['schemaVersion', 'kind', 'packageVersion', 'publicSourceRevision', 'sourceDigest', 'treeDigest', 'packageArtifactId', 'files']);
  // Deployment-side inspection must retain the exact pre-bootstrap format-4
  // inventory. Client startup/build stays strict to the current inventory.
  const previousFiles = currentFiles.filter(file => file !== 'dist/publicLink/compatibility.js');
  const files = options.allowPreviousInventory && JSON.stringify(value.files) === JSON.stringify(previousFiles)
    ? previousFiles : currentFiles;
  if (value.schemaVersion !== 1 || value.kind !== 'public-link-source-build'
    || typeof value.packageVersion !== 'string' || !value.packageVersion
    || typeof value.publicSourceRevision !== 'string' || !/^[a-f0-9]{40,64}$/.test(value.publicSourceRevision)
    || JSON.stringify(value.files) !== JSON.stringify(files)) throw new Error('Public source build identity is invalid');
  const sourceDigest = digestValue(value.sourceDigest, 'source digest');
  const treeDigest = digestValue(value.treeDigest, 'tree digest');
  const packageArtifactId = digestValue(value.packageArtifactId, 'package artifact id');
  const metadata = objectValue(readJson(path.join(root, 'package.json')), 'package metadata');
  exactKeys(objectValue(metadata.cekaiLink, 'package metadata'), ['packageFormat']);
  if (metadata.name !== '@cekaitech/cekai-link' || metadata.version !== value.packageVersion
    || objectValue(metadata.cekaiLink, 'package metadata').packageFormat !== 4
    || objectValue(metadata.bin, 'package bin')['cekai-link'] !== 'bin/cekai-link-source.cjs'
    || Object.keys(objectValue(metadata.dependencies ?? {}, 'dependencies')).length !== 0
    || metadata.bundleDependencies !== undefined) throw new Error('Public source package metadata is invalid');
  if (metadata.license !== undefined && metadata.license !== 'UNLICENSED') {
    if (!['Apache-2.0', 'MIT'].includes(String(metadata.license)) || !files.includes('LICENSE')) throw new Error('Public source package requires its declared license file');
  }
  const observedFiles: string[] = [];
  collect(path.join(root, 'dist'), root, observedFiles);
  collect(path.join(root, 'bin'), root, observedFiles);
  if (JSON.stringify(observedFiles.sort()) !== JSON.stringify(files.filter((file) => file.startsWith('dist/') || file.startsWith('bin/')))) {
    throw new Error('Public source package contains unreviewed runtime files');
  }
  const hash = createHash('sha256');
  for (const file of files) {
    const absolute = path.join(root, file);
    regularFile(absolute);
    hash.update(file).update('\0').update(readFileSync(absolute)).update('\0');
  }
  if (`sha256:${hash.digest('hex')}` !== treeDigest) throw new Error('Public source package runtime digest is invalid');
  const expectedId = `sha256:${createHash('sha256').update(JSON.stringify({
    schemaVersion: 1, packageVersion: value.packageVersion, publicSourceRevision: value.publicSourceRevision, sourceDigest, treeDigest
  })).digest('hex')}`;
  if (expectedId !== packageArtifactId) throw new Error('Public source package identity is invalid');
  return { schemaVersion: 1, kind: 'public-link-source-build', packageVersion: value.packageVersion,
    publicSourceRevision: value.publicSourceRevision, sourceDigest, treeDigest, packageArtifactId, files };
}

/** A downloaded or manually supplied mapping never grants Central approval by itself. */
export function parsePublicLinkCompatibility(value: unknown, packageArtifactId: PublicLinkDigest): PublicLinkRuntimeIdentity {
  const mapping = objectValue(value, 'Central compatibility mapping');
  exactKeys(mapping, ['schemaVersion', 'packageArtifactId', 'releaseId', 'sourceRevision', 'protocolVersion', 'contractDigest', 'sourceLinkRoleDigest', 'sourceLinkComponentDigests']);
  if (mapping.schemaVersion !== 1 || digestValue(mapping.packageArtifactId, 'mapping package identity') !== packageArtifactId
    || typeof mapping.sourceRevision !== 'string' || !mapping.sourceRevision.trim() || mapping.sourceRevision.length > 80
    || !Number.isInteger(mapping.protocolVersion) || Number(mapping.protocolVersion) < 1) {
    throw new Error('Central compatibility mapping does not match this public package');
  }
  const components = objectValue(mapping.sourceLinkComponentDigests, 'Central component digests');
  exactKeys(components, ['mcp', 'schemas', 'skills']);
  return {
    role: 'link',
    publicPackageArtifactId: packageArtifactId,
    releaseId: digestValue(mapping.releaseId, 'Central release identity'),
    // Wire sourceRevision is the Central compatibility revision, NOT the public Git revision.
    sourceRevision: mapping.sourceRevision,
    protocolVersion: Number(mapping.protocolVersion),
    contractDigest: digestValue(mapping.contractDigest, 'Central contract digest'),
    roleDigest: digestValue(mapping.sourceLinkRoleDigest, 'Central role digest'),
    componentDigests: { mcp: digestValue(components.mcp, 'component digest'), schemas: digestValue(components.schemas, 'component digest'), skills: digestValue(components.skills, 'component digest') }
  };
}

export function readPublicSourceRuntimeIdentity(packageRoot: string, mappingPath = process.env.CEKAI_LINK_COMPATIBILITY_PATH?.trim() || storedPublicLinkCompatibilityPath()): PublicLinkRuntimeIdentity {
  const build = verifyPublicSourcePackage(packageRoot);
  if (!mappingPath || !path.isAbsolute(mappingPath)) throw new Error('Central compatibility mapping is required; run cekai-link setup to obtain it or select an owner-provided file');
  const relative = path.relative(packageRoot, mappingPath);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Central compatibility mapping must remain outside the public package');
  }
  let canonicalRelative: string;
  try {
    regularFile(mappingPath);
    canonicalRelative = path.relative(realpathSync(packageRoot), realpathSync(mappingPath));
  } catch { throw new Error('Central compatibility mapping could not be read; run cekai-link setup to obtain matching material'); }
  if (canonicalRelative === '' || (!canonicalRelative.startsWith(`..${path.sep}`) && canonicalRelative !== '..' && !path.isAbsolute(canonicalRelative))) {
    throw new Error('Central compatibility mapping must remain outside the public package');
  }
  try { return parsePublicLinkCompatibility(readJson(mappingPath), build.packageArtifactId); }
  catch { throw new Error('Central compatibility mapping is invalid or does not match this public package; ask the deployment owner for the matching file'); }
}

function readJson(file: string): unknown { regularFile(file); return JSON.parse(readFileSync(file, 'utf8')); }
function regularFile(file: string): void {
  const details = lstatSync(file);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error('Public Link identity files must be regular files');
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error('Public Link identity contains unsupported fields');
}
function collect(directory: string, root: string, files: string[]): void {
  const details = lstatSync(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('Public Link package directory is invalid');
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Public Link package cannot contain symbolic links');
    if (entry.isDirectory()) collect(absolute, root, files);
    else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll('\\', '/'));
    else throw new Error('Public Link package contains an unsupported file');
  }
}
