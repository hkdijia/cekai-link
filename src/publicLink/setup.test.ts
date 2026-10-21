import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicLinkConfigStore } from './config.js';
import { createPublicLinkApi } from './api.js';
import { runPublicLinkSetup } from './setup.js';
import { SOURCE_PACKAGE_FILES, readPublicSourceRuntimeIdentity } from './packageIdentity.js';
import { downloadedCompatibilityPath, saveDownloadedCompatibility } from './compatibility.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}` as const;

async function fixture() {
  const scratch = await mkdtemp(path.join(tmpdir(), 'link-setup-')); roots.push(scratch);
  const root = path.join(scratch, 'package');
  const hash = createHash('sha256');
  for (const file of SOURCE_PACKAGE_FILES) {
    const target = path.join(root, file); await mkdir(path.dirname(target), { recursive: true });
    const contents = file === 'package.json' ? JSON.stringify({ name: '@cekaitech/cekai-link', version: '0.1.3-setup.0',
      bin: { 'cekai-link': 'bin/cekai-link-source.cjs' }, cekaiLink: { packageFormat: 4 } }) : 'fixture\n';
    await writeFile(target, contents); hash.update(file).update('\0').update(contents).update('\0');
  }
  const descriptor = { schemaVersion: 1, packageVersion: '0.1.3-setup.0', publicSourceRevision: 'a'.repeat(40),
    sourceDigest: digest('source'), treeDigest: `sha256:${hash.digest('hex')}` };
  const packageArtifactId = digest(JSON.stringify(descriptor));
  await writeFile(path.join(root, 'link-build.json'), JSON.stringify({ ...descriptor, kind: 'public-link-source-build', packageArtifactId, files: SOURCE_PACKAGE_FILES }));
  const mapping = { schemaVersion: 1, packageArtifactId, releaseId: digest('release'), sourceRevision: 'b'.repeat(40),
    protocolVersion: 1, contractDigest: digest('contract'), sourceLinkRoleDigest: digest('role'),
    sourceLinkComponentDigests: { mcp: digest('mcp'), schemas: digest('schemas'), skills: digest('skills') } };
  vi.stubEnv('CEKAI_LINK_SOURCE_PACKAGE_ROOT', root); vi.stubEnv('CEKAI_LINK_COMPATIBILITY_PATH', '');
  const config = createPublicLinkConfigStore(path.join(scratch, 'state', 'config.json'));
  const api = { ...createPublicLinkApi(), pair: vi.fn(async () => ({ credential: 'synthetic', workerId: 'worker', deviceId: 'device' })) };
  const fetchPort = vi.fn(async () => new Response(JSON.stringify(mapping)));
  const prompts: string[] = []; const output: string[] = [];
  let answers: string[] = [];
  const input = { config, api, fetch: fetchPort, codexInstallation: () => 'found' as const,
    ask: async (prompt: string, secret?: boolean) => {
      prompts.push(prompt);
      const answer = answers.shift();
      if (answer === 'fixture-code') expect(secret).toBe(true);
      return answer;
    }, output: (line: string) => output.push(line) };
  return { scratch, root, config, mapping, api, fetchPort, prompts, output, input,
    answer: (...values: string[]) => { answers = values; } };
}

describe('public setup compatibility bootstrap', () => {
  it('needs no file or path input, saves a validated download, hides the code and resumes without pairing again', async () => {
    const f = await fixture();
    f.answer('https://central.example', 'fixture-code', 'device', '');
    await runPublicLinkSetup(f.input);
    expect(f.prompts).toHaveLength(4); expect(f.prompts.some(prompt => prompt.includes('兼容文件'))).toBe(false);
    expect(f.fetchPort).toHaveBeenCalledTimes(1); expect(f.api.pair).toHaveBeenCalledTimes(1);
    const config = await f.config.load();
    expect(config).toMatchObject({ credential: 'synthetic', serverUrl: 'https://central.example' });
    expect(readPublicSourceRuntimeIdentity(f.root, config!.compatibilityPath).publicPackageArtifactId).toBe(f.mapping.packageArtifactId);
    f.prompts.length = 0; f.answer('');
    await runPublicLinkSetup(f.input);
    expect(f.prompts).toHaveLength(1); expect(f.prompts[0]).toContain('工作区');
    expect(f.fetchPort).toHaveBeenCalledTimes(1); expect(f.api.pair).toHaveBeenCalledTimes(1);
  });

  it('verifies the local package and Codex before any download or pairing prompt', async () => {
    const f = await fixture();
    await runPublicLinkSetup({ ...f.input, codexInstallation: () => 'missing' });
    expect(f.prompts).toEqual([]); expect(f.output.join('')).toContain('Codex CLI'); expect(f.fetchPort).not.toHaveBeenCalled();
    await writeFile(path.join(f.root, 'dist/publicLink/setup.js'), 'tampered');
    await expect(runPublicLinkSetup(f.input)).rejects.toThrow('digest');
    expect(f.api.pair).not.toHaveBeenCalled(); expect(await f.config.load()).toBeUndefined();
  });

  it('resumes the validated download even when interrupted before pairing, with no offline fetch', async () => {
    const f = await fixture(); f.answer('https://central.example', '');
    await runPublicLinkSetup(f.input); expect(await f.config.load()).toBeUndefined();
    f.fetchPort.mockRejectedValue(new Error('offline')); f.answer('https://central.example', 'fixture-code', 'device', '');
    await runPublicLinkSetup(f.input);
    expect(f.fetchPort).toHaveBeenCalledTimes(1); expect(f.api.pair).toHaveBeenCalledTimes(1);
    expect(downloadedCompatibilityPath(f.config.filePath, 'https://other.example', f.mapping.packageArtifactId))
      .not.toBe((await f.config.load())!.compatibilityPath);
  });

  it('honors a manual override offline and never masks an invalid explicit override with network fallback', async () => {
    const f = await fixture(); const file = path.join(f.scratch, 'manual.json');
    vi.stubEnv('CEKAI_LINK_COMPATIBILITY_PATH', file);
    await expect(runPublicLinkSetup(f.input)).rejects.toThrow('could not be read');
    expect(f.prompts).toEqual([]); expect(f.fetchPort).not.toHaveBeenCalled();
    await writeFile(file, JSON.stringify(f.mapping)); f.answer('https://central.example', 'fixture-code', 'device', '');
    await runPublicLinkSetup(f.input); expect((await f.config.load())?.compatibilityPath).toBe(file);
    expect(f.fetchPort).not.toHaveBeenCalled();
  });

  it('provides the manual-file next step for old Central without consuming a code', async () => {
    const f = await fixture(); f.fetchPort.mockResolvedValue(new Response('{}', { status: 404 }));
    f.answer('https://central.example', ''); await runPublicLinkSetup(f.input);
    expect(f.prompts).toHaveLength(2); expect(f.prompts[1]).toContain('旧 Central');
    expect(f.api.pair).not.toHaveBeenCalled(); expect(await f.config.load()).toBeUndefined();
    const file = path.join(f.scratch, 'manual.json'); await writeFile(file, JSON.stringify(f.mapping));
    f.answer('https://central.example', file, 'fixture-code', 'device', '');
    await runPublicLinkSetup(f.input); expect((await f.config.load())?.compatibilityPath).toBe(file);
  });

  it('preserves paired configuration and old mapping byte-for-byte on invalid download', async () => {
    const f = await fixture(); const oldPath = path.join(f.scratch, 'old.json');
    await writeFile(oldPath, JSON.stringify({ ...f.mapping, packageArtifactId: digest('old-package') }));
    await f.config.save({ version: 1, serverUrl: 'https://central.example', credential: 'synthetic', workerId: 'worker', deviceId: 'device', deviceName: 'device', compatibilityPath: oldPath });
    const before = await readFile(f.config.filePath); const old = await readFile(oldPath);
    f.fetchPort.mockResolvedValue(new Response(JSON.stringify({ ...f.mapping, credential: 'forbidden' })));
    f.answer(''); await runPublicLinkSetup(f.input);
    expect(await readFile(f.config.filePath)).toEqual(before); expect(await readFile(oldPath)).toEqual(old);
    expect(f.api.pair).not.toHaveBeenCalled(); expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).toContain('兼容文件'); expect(f.output.join('')).not.toContain('forbidden');
  });

  it('validates a temporary mapping before replacing owned material and rejects package/workspace writes', async () => {
    const f = await fixture(); const filePath = downloadedCompatibilityPath(f.config.filePath, 'https://central.example', f.mapping.packageArtifactId);
    await saveDownloadedCompatibility({ filePath, packageRoot: f.root, mapping: f.mapping });
    const before = await readFile(filePath);
    await expect(saveDownloadedCompatibility({ filePath, packageRoot: f.root, mapping: { ...f.mapping, packageArtifactId: digest('wrong') } })).rejects.toThrow();
    expect(await readFile(filePath)).toEqual(before); expect((await readdir(path.dirname(filePath))).some(file => file.endsWith('.tmp'))).toBe(false);
    await expect(saveDownloadedCompatibility({ filePath: path.join(f.root, 'mapping.json'), packageRoot: f.root, mapping: f.mapping })).rejects.toThrow('outside');
    await expect(saveDownloadedCompatibility({ filePath, packageRoot: f.root, workspaceRoot: f.scratch, mapping: f.mapping })).rejects.toThrow('outside');
  });
});
