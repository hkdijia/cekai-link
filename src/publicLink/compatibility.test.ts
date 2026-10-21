import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { downloadPublicLinkCompatibility } from './compatibility.js';

const digest = `sha256:${'a'.repeat(64)}` as const;
const mapping = { schemaVersion: 1, packageArtifactId: digest, releaseId: digest, sourceRevision: 'active',
  protocolVersion: 1, contractDigest: digest, sourceLinkRoleDigest: digest,
  sourceLinkComponentDigests: { mcp: digest, schemas: digest, skills: digest } };

describe('bounded compatibility download', () => {
  it('uses only the fixed origin/path and package identity without credentials or private input', async () => {
    const fetchPort = vi.fn(async () => new Response(JSON.stringify(mapping)));
    await expect(downloadPublicLinkCompatibility('https://central.example', digest, { fetch: fetchPort })).resolves.toEqual(mapping);
    const [url, options] = fetchPort.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.origin).toBe('https://central.example'); expect(url.pathname).toBe('/api/link/compatibility');
    expect([...url.searchParams]).toEqual([['packageArtifactId', digest]]);
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', headers: { accept: 'application/json' } });
    expect(options.body).toBeUndefined(); expect(options.headers).not.toHaveProperty('authorization');
    await expect(downloadPublicLinkCompatibility('https://central.example/path', digest, { fetch: fetchPort })).rejects.toThrow('origin');
    await expect(downloadPublicLinkCompatibility('http://remote.example', digest, { fetch: fetchPort })).rejects.toThrow('HTTPS');
    expect(fetchPort).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['invalid JSON', () => new Response('{broken')],
    ['extra fields', () => new Response(JSON.stringify({ ...mapping, credential: 'private' }))],
    ['wrong package', () => new Response(JSON.stringify({ ...mapping, packageArtifactId: `sha256:${'b'.repeat(64)}` }))],
    ['missing components', () => new Response(JSON.stringify({ ...mapping, sourceLinkComponentDigests: {} }))],
    ['oversized declared body', () => new Response('{}', { headers: { 'content-length': '16385' } })],
    ['oversized streamed body', () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16385)); controller.close(); } }))],
    ['unknown package', () => new Response('{}', { status: 404 })],
    ['disabled transition', () => new Response('{}', { status: 503 })]
  ])('rejects %s before any material is persisted', async (_name, response) => {
    await expect(downloadPublicLinkCompatibility('https://central.example', digest, { fetch: async () => response() })).rejects.toThrow('Central ');
  });

  it('rejects real redirects and times out stalled headers and stalled response bodies', async () => {
    let redirects = 0;
    const server = createServer((request, response) => {
      const packageId = new URL(request.url!, 'http://localhost').searchParams.get('packageArtifactId');
      if (packageId === `sha256:${'b'.repeat(64)}`) { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); return; }
      if (packageId === `sha256:${'c'.repeat(64)}`) return;
      if (request.url === '/redirect-target') { redirects++; response.end('{}'); return; }
      response.writeHead(302, { location: '/redirect-target' }); response.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture bind failed');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      await expect(downloadPublicLinkCompatibility(origin, digest)).rejects.toThrow('重定向'); expect(redirects).toBe(0);
      for (const digit of ['b', 'c']) await expect(downloadPublicLinkCompatibility(origin, `sha256:${digit.repeat(64)}`, { timeoutMs: 50 })).rejects.toThrow('超时');
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
