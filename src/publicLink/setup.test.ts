import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicLinkConfigStore } from './config.js';
import { createPublicLinkApi } from './api.js';
import { runPublicLinkSetup } from './setup.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('public setup first use', () => {
  it('validates the mapping and locates Codex before collecting or consuming a pairing code', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'link-setup-')); roots.push(root);
    vi.stubEnv('CEKAI_LINK_SOURCE_PACKAGE_ROOT', root); vi.stubEnv('CEKAI_LINK_COMPATIBILITY_PATH', '');
    const config = createPublicLinkConfigStore(path.join(root, 'config.json'));
    const prompts: string[] = []; const output: string[] = [];
    const pairing = vi.fn();
    await runPublicLinkSetup({ config, api: { ...createPublicLinkApi(), pair: pairing },
      ask: async prompt => { prompts.push(prompt); return path.join(root, 'compatibility.json'); }, output: line => output.push(line),
      resolveIdentity: () => { throw new Error('mapping invalid'); }, codexInstallation: () => 'missing' }).catch(error => expect(error.message).toBe('mapping invalid'));
    expect(prompts).toHaveLength(1); expect(prompts[0]).toContain('兼容文件'); expect(pairing).not.toHaveBeenCalled();
    prompts.length = 0;
    await runPublicLinkSetup({ config, api: { ...createPublicLinkApi(), pair: pairing },
      ask: async prompt => { prompts.push(prompt); return path.join(root, 'compatibility.json'); }, output: line => output.push(line),
      resolveIdentity: () => undefined, codexInstallation: () => 'missing' });
    expect(prompts).toHaveLength(1); expect(output.join('\n')).toContain('Codex CLI');
    expect(pairing).not.toHaveBeenCalled(); expect(await config.load()).toBeUndefined();
  });

  it('keeps pairing and the validated mapping on workspace interruption and skips both prompts on rerun', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'link-setup-resume-')); roots.push(root);
    const mappingPath = path.join(root, 'compatibility.json');
    vi.stubEnv('CEKAI_LINK_SOURCE_PACKAGE_ROOT', root); vi.stubEnv('CEKAI_LINK_COMPATIBILITY_PATH', '');
    const config = createPublicLinkConfigStore(path.join(root, 'config.json'));
    const api = { ...createPublicLinkApi(), pair: vi.fn(async () => ({ credential: 'synthetic', workerId: 'worker', deviceId: 'device' })) };
    const inputs = [mappingPath, 'http://127.0.0.1', 'synthetic-code', 'device name', ''];
    const prompts: string[] = [];
    const resolveIdentity = vi.fn(() => undefined);
    await runPublicLinkSetup({ config, api, ask: async prompt => { prompts.push(prompt); return inputs.shift(); }, output: () => {}, resolveIdentity, codexInstallation: () => 'found' });
    expect(await config.load()).toMatchObject({ credential: 'synthetic', compatibilityPath: mappingPath });
    expect(resolveIdentity).toHaveBeenCalledWith(mappingPath);
    prompts.length = 0;
    await runPublicLinkSetup({ config, api, ask: async prompt => { prompts.push(prompt); return ''; }, output: () => {}, resolveIdentity, codexInstallation: () => 'found' });
    expect(prompts).toHaveLength(1); expect(prompts[0]).toContain('工作区'); expect(api.pair).toHaveBeenCalledTimes(1);
  });
});
