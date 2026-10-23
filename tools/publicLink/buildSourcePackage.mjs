#!/usr/bin/env node
// Copied verbatim to the standalone project. Only Node built-ins are used.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicSourcePackageFiles, verifyPublicSourcePackage } from '../../dist/publicLink/packageIdentity.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
if (path.resolve(git('rev-parse', '--show-toplevel')) !== root) throw new Error('Standalone build requires its own source Git repository');
if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('Standalone source tree must be clean before build identity generation');
const publicSourceRevision = git('rev-parse', 'HEAD');
const tracked = git('ls-files', '-z').split('\0').filter(Boolean).sort();
const permitted = (file) => /^src\/publicLink\/[A-Za-z]+(?:\.test)?\.ts$/.test(file)
  || /^src\/adapters\/publicLinkService\/native(?:\.test)?\.ts$/.test(file)
  || ['.gitignore', 'README.md', 'LICENSE', 'NOTICE', 'package.json', 'package-lock.json', 'tsconfig.json', 'bin/cekai-link-source.cjs', 'tools/publicLink/buildSourcePackage.mjs', '.github/workflows/verify.yml', '.github/workflows/publish.yml'].includes(file);
if (tracked.some((file) => !permitted(file))) throw new Error('Standalone source contains an unreviewed tracked file');
const digest = (files) => {
  const hash = createHash('sha256');
  for (const file of files) {
    const absolute = path.join(root, file);
    const details = lstatSync(absolute);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error('Standalone build inputs must be regular files');
    hash.update(file).update('\0').update(readFileSync(absolute)).update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
};
const packageVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const sourceDigest = digest(tracked);
const files = publicSourcePackageFiles(root);
const treeDigest = digest(files);
const descriptor = { schemaVersion: 1, packageVersion, publicSourceRevision, sourceDigest, treeDigest };
const packageArtifactId = `sha256:${createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')}`;
writeFileSync(path.join(root, 'link-build.json'), JSON.stringify({
  ...descriptor, kind: 'public-link-source-build', packageArtifactId, files
}, null, 2) + '\n');
verifyPublicSourcePackage(root);
process.stdout.write(JSON.stringify({ ok: true, ...descriptor, packageArtifactId }) + '\n');
