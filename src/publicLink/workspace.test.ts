import { describe, expect, it } from 'vitest';
import { normalizePublicLinkPath, validatePublicLinkWorkspace } from './workspace.js';

describe('public Link workspace boundary', () => {
  it('normalizes paths using the selected OS without importing private path adapters', () => {
    expect(normalizePublicLinkPath('/tmp/./project', 'macos')).toBe('/tmp/project');
    expect(normalizePublicLinkPath('C:\\Work\\Project\\.', 'windows')).toBe('c:\\work\\project');
  });

  it('accepts a canonical folder but rejects symlink roots and non-absolute paths', async () => {
    const ports = {
      async lstat() { return { isDirectory: () => true, isSymbolicLink: () => false }; },
      async realpath(value: string) { return value; },
      async readlink() { return ''; },
      async readdir() { return []; },
      async git() { throw new Error('not a git workspace'); }
    };
    await expect(validatePublicLinkWorkspace('/tmp/public-link-folder', 'macos', ports)).resolves.toMatchObject({ workspaceKind: 'folder' });
    await expect(validatePublicLinkWorkspace('relative-folder', 'macos', ports)).rejects.toThrow('absolute local path');
    await expect(validatePublicLinkWorkspace('/tmp/linked-folder', 'macos', {
      ...ports,
      async lstat() { return { isDirectory: () => true, isSymbolicLink: () => true }; }
    })).rejects.toThrow('direct local folder');
  });
});
