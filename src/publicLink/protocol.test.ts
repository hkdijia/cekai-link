import { describe, expect, it } from 'vitest';
import { parsePublicLinkConfig, parseWorkspace } from './protocol.js';

const digest = `sha256:${'a'.repeat(64)}` as const;

describe('public Link protocol boundary', () => {
  it('accepts only a paired read-only workspace configuration', () => {
    expect(parsePublicLinkConfig({
      version: 1, serverUrl: 'https://central.example.test', credential: 'credential', workerId: 'worker', deviceId: 'device', deviceName: 'Mac',
      workspace: { replicaId: 'replica', projectId: 'project', workspaceId: 'workspace', rootIdentity: digest, rootDigest: 'root', canonicalRoot: '/tmp/project', os: 'macos', workspaceKind: 'git-root' }
    }).workspace?.workspaceKind).toBe('git-root');
  });

  it('rejects capability, integration and write-shaped fields instead of ignoring them', () => {
    expect(() => parsePublicLinkConfig({ version: 1, serverUrl: 'https://central.example.test', credential: 'credential', workerId: 'worker', deviceId: 'device', deviceName: 'Mac', capabilities: ['workspace-write'] })).toThrow('unsupported fields');
    expect(() => parseWorkspace({ replicaId: 'replica', projectId: 'project', workspaceId: 'workspace', rootIdentity: digest, rootDigest: 'root', canonicalRoot: '/tmp/project', os: 'macos', workspaceKind: 'git-root', integration: true })).toThrow('unsupported fields');
  });

  it('rejects non-loopback HTTP Central URLs', () => {
    expect(() => parsePublicLinkConfig({ version: 1, serverUrl: 'http://central.example.test', credential: 'credential', workerId: 'worker', deviceId: 'device', deviceName: 'Mac' })).toThrow('HTTPS');
  });

  it('accepts IPv6 loopback HTTP only for local fixtures', () => {
    expect(parsePublicLinkConfig({ version: 1, serverUrl: 'http://[::1]:8000', credential: 'credential', workerId: 'worker', deviceId: 'device', deviceName: 'device' }).serverUrl).toBe('http://[::1]:8000');
  });
});
