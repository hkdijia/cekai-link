import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readlink, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { currentPublicLinkOs } from './config.js';
import type { PublicLinkOs, PublicLinkWorkspaceKind } from './protocol.js';

const execute = promisify(execFile);

export interface PublicLinkValidatedWorkspace {
  readonly canonicalRoot: string;
  readonly rootIdentity: `sha256:${string}`;
  readonly workspaceId: `workspace_${string}`;
  readonly rootDigest: string;
  readonly os: PublicLinkOs;
  readonly workspaceKind: PublicLinkWorkspaceKind;
}

export interface PublicLinkWorkspaceValidationPorts {
  lstat(value: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean; isReparsePoint?: boolean }>;
  realpath(value: string): Promise<string>;
  readlink(value: string): Promise<string>;
  readdir(value: string): Promise<readonly { name: string; isDirectory(): boolean }[]>;
  git(cwd: string, args: readonly string[]): Promise<string>;
}

/**
 * Public Link only observes a local directory. It never writes to the
 * directory, executes a project command, or follows an indirect root.
 */
export async function validatePublicLinkWorkspace(
  input: string,
  os = currentPublicLinkOs(),
  ports: PublicLinkWorkspaceValidationPorts = systemPorts()
): Promise<PublicLinkValidatedWorkspace> {
  const configured = parsePath(input, os);
  let details;
  try { details = await ports.lstat(configured); } catch { throw new Error('Workspace directory is unavailable: [configured-path]'); }
  if (!details.isDirectory() || details.isSymbolicLink() || details.isReparsePoint === true) throw new Error('Workspace directory must be a direct local folder: [configured-path]');
  const platformPath = os === 'windows' ? path.win32 : path.posix;
  const canonicalRoot = platformPath.normalize(await ports.realpath(configured));
  if (!samePath(configured, canonicalRoot, os)) throw new Error('Workspace directory must be canonical: [configured-path]');

  const git = await detectGitRoot(canonicalRoot, os, ports);
  if (git) {
    const rootDigest = digest(JSON.stringify({ version: 1, remote: git.remote, roots: git.roots }));
    const workspaceDigest = digest(JSON.stringify({ version: 1, rootDigest, gitDir: digest(normalize(git.gitDir, os)) }));
    return {
      canonicalRoot, rootIdentity: `sha256:${rootDigest}`, workspaceId: `workspace_${workspaceDigest}`,
      rootDigest, os, workspaceKind: 'git-root'
    };
  }

  const rootDigest = digest(JSON.stringify({ version: 1, kind: 'workspace-folder', path: digest(normalize(canonicalRoot, os)) }));
  const workspaceDigest = digest(JSON.stringify({ version: 1, rootDigest }));
  return {
    canonicalRoot, rootIdentity: `sha256:${rootDigest}`, workspaceId: `workspace_${workspaceDigest}`,
    rootDigest, os, workspaceKind: 'folder'
  };
}

export function normalizePublicLinkPath(value: string, os: PublicLinkOs): string {
  const platformPath = os === 'windows' ? path.win32 : path.posix;
  const normalized = platformPath.normalize(value);
  return os === 'windows' ? normalized.toLowerCase() : normalized;
}

function parsePath(value: string, os: PublicLinkOs): string {
  const platformPath = os === 'windows' ? path.win32 : path.posix;
  if (!value || !platformPath.isAbsolute(value) || (os === 'windows' && !/^[a-zA-Z]:[\\/]/.test(value))) {
    throw new Error('Workspace directory must be an absolute local path: [configured-path]');
  }
  const pieces = value.split(os === 'windows' ? /[\\/]/ : '/');
  if (pieces.includes('..') || pieces.some((piece) => piece.toLowerCase() === '.git')) {
    throw new Error('Workspace directory path is not allowed: [configured-path]');
  }
  return platformPath.normalize(value);
}

async function detectGitRoot(root: string, os: PublicLinkOs, ports: PublicLinkWorkspaceValidationPorts): Promise<{ remote: string; roots: string[]; gitDir: string } | undefined> {
  const platformPath = os === 'windows' ? path.win32 : path.posix;
  let top: string;
  try {
    top = platformPath.normalize((await ports.git(root, ['rev-parse', '--show-toplevel'])).trim());
  } catch { return undefined; }
  if (!samePath(root, top, os)) return undefined;
  const rawGitDir = (await ports.git(root, ['rev-parse', '--absolute-git-dir'])).trim();
  const gitDir = platformPath.normalize(platformPath.isAbsolute(rawGitDir) ? rawGitDir : platformPath.resolve(root, rawGitDir));
  const rawCommonDir = (await ports.git(root, ['rev-parse', '--git-common-dir'])).trim();
  const commonDir = platformPath.normalize(platformPath.isAbsolute(rawCommonDir) ? rawCommonDir : platformPath.resolve(root, rawCommonDir));
  const expectedGitDir = platformPath.join(root, '.git');
  const linkedWorktreeDir = platformPath.join(commonDir, 'worktrees');
  const regularWorktree = samePath(gitDir, expectedGitDir, os) && samePath(commonDir, expectedGitDir, os);
  const linkedWorktree = isPathInside(gitDir, linkedWorktreeDir, os) && !samePath(gitDir, linkedWorktreeDir, os);
  if (!regularWorktree && !linkedWorktree) throw new Error('Git metadata layout is not supported');
  if ((await ports.git(root, ['rev-parse', '--show-superproject-working-tree']).catch(() => '')).trim()) throw new Error('Workspace is inside a Git superproject');
  const headRoots = (await ports.git(root, ['rev-list', '--max-parents=0', 'HEAD'])).trim().toLowerCase().split(/\s+/).filter(Boolean).sort();
  if (!headRoots.length || headRoots.some((item) => !/^[a-f0-9]{40,64}$/.test(item))) throw new Error('Git repository identity is unavailable');
  const tracked = (await ports.git(root, ['ls-files', '-z', '--cached'])).split('\0').filter(Boolean);
  const staged = (await ports.git(root, ['ls-files', '--stage', '-z', '--cached'])).split('\0').filter(Boolean);
  if (tracked.length > 100_000 || staged.some((record) => record.startsWith('160000 '))) throw new Error('Git index is not supported');
  await verifyTrackedSymlinks(root, os, ports, tracked);
  const remote = (await ports.git(root, ['config', '--get', 'remote.origin.url']).catch(() => '')).trim().replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  return { remote, roots: headRoots, gitDir };
}

async function verifyTrackedSymlinks(root: string, os: PublicLinkOs, ports: PublicLinkWorkspaceValidationPorts, tracked: readonly string[]): Promise<void> {
  const platformPath = os === 'windows' ? path.win32 : path.posix;
  const visited = new Set<string>();
  for (const relative of tracked) {
    if (!relative || relative.length > 4_096 || platformPath.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Git index contains an unsafe path');
    const parts = relative.split(/[\\/]/).filter(Boolean);
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const candidate = platformPath.join(root, ...parts.slice(0, depth));
      const key = normalize(candidate, os);
      if (visited.has(key)) continue;
      visited.add(key);
      try {
        const details = await ports.lstat(candidate);
        if (details.isSymbolicLink() || details.isReparsePoint === true) {
          const target = await ports.readlink(candidate);
          const resolvedTarget = platformPath.resolve(platformPath.dirname(candidate), target);
          if (!samePath(resolvedTarget, root, os) && !isPathInside(resolvedTarget, root, os)) throw new Error('Tracked symbolic link escapes the workspace');
        }
        const resolved = platformPath.normalize(await ports.realpath(candidate));
        if (!samePath(resolved, root, os) && !isPathInside(resolved, root, os)) throw new Error('Tracked path escapes the workspace');
      } catch (error) {
        if (isCode(error, 'ENOENT')) break;
        throw error;
      }
    }
  }
}

function normalize(value: string, os: PublicLinkOs): string {
  const platformPath = os === 'windows' ? path.win32 : path.posix;
  const normalized = platformPath.normalize(value);
  return os === 'windows' ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string, os: PublicLinkOs): boolean { return normalize(left, os) === normalize(right, os); }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

export async function listDirectChildRepositories(root: string, os = currentPublicLinkOs()): Promise<readonly PublicLinkValidatedWorkspace[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const results: PublicLinkValidatedWorkspace[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try { results.push(await validatePublicLinkWorkspace(path.join(root, entry.name), os)); }
    catch { /* A folder without a valid repository is not exposed. */ }
  }
  return results.filter((item) => item.workspaceKind === 'git-root');
}

function systemPorts(): PublicLinkWorkspaceValidationPorts {
  return {
    async lstat(value) {
      const details = await lstat(value);
      return { isDirectory: () => details.isDirectory(), isSymbolicLink: () => details.isSymbolicLink(), isReparsePoint: process.platform === 'win32' && details.isSymbolicLink() };
    },
    realpath,
    readlink,
    async readdir(value) { return readdir(value, { withFileTypes: true }); },
    async git(cwd, args) { return (await execute('git', [...args], { cwd, windowsHide: true, maxBuffer: 512 * 1024 })).stdout; }
  };
}

function isPathInside(value: string, parent: string, os: PublicLinkOs): boolean {
  const platformPath = os === 'windows' ? path.win32 : path.posix;
  const relative = platformPath.relative(normalize(parent, os), normalize(value, os));
  return relative !== '' && !relative.startsWith(`..${platformPath.sep}`) && relative !== '..' && !platformPath.isAbsolute(relative);
}

function isCode(error: unknown, code: string): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === code; }
