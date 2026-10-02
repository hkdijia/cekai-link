import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicLinkApi } from './api.js';
import { createServer } from 'node:http';

afterEach(() => vi.useRealTimers());

describe('public Link Central API', () => {
  it('pairs with the read-only capability only', async () => {
    const fetchPort = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => new Response(JSON.stringify({
      ok: true, credential: 'credential', worker: { workerId: 'worker', deviceId: 'device' }
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const api = createPublicLinkApi(fetchPort as typeof fetch);
    await api.pair('http://127.0.0.1', 'pairing-code', 'Mac');
    const body = JSON.parse(String(fetchPort.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ capabilities: ['read-only'], code: 'pairing-code' });
    expect(JSON.stringify(body)).not.toMatch(/workspace-write|integration|mcp/i);
  });

  it('does not fall back to an unmarked Worker when external Central identity is missing', async () => {
    const fetchPort = vi.fn();
    const api = createPublicLinkApi(fetchPort as typeof fetch);
    await expect(api.pair('https://central.example.test', 'code', 'Mac')).rejects.toThrow('exact package');
    await expect(api.register('https://central.example.test', 'credential')).rejects.toThrow('exact package');
    expect(fetchPort).not.toHaveBeenCalled();
  });

  it('rejects a task whose request bytes do not match Central digest', async () => {
    const fetchPort = vi.fn(async () => new Response(JSON.stringify({ ok: true, claim: {
      taskId: 'task', executionId: 'execution', bindingRef: 'binding', environmentProfile: 'prod-readonly',
      requestDigest: `sha256:${'0'.repeat(64)}`, requestBase64: Buffer.from('question').toString('base64'),
      target: { deviceId: 'device', workerId: 'worker', projectId: 'project', replicaId: 'replica', workspaceId: 'workspace', rootIdentity: `sha256:${'a'.repeat(64)}` },
      leaseExpiresAt: Date.now() + 60_000
    } }), { status: 200 }));
    await expect(createPublicLinkApi(fetchPort as typeof fetch).claim('https://central.example.test', 'credential', 60_000))
      .rejects.toThrow('digest does not match');
  });

  it('pins redirect rejection and aborts a request that never returns', async () => {
    vi.useFakeTimers();
    const fetchPort = vi.fn((_url: URL | RequestInfo, _options?: RequestInit) => new Promise<Response>(() => {}));
    const pending = createPublicLinkApi(fetchPort as typeof fetch, { timeoutMs: 20 }).pair('http://127.0.0.1', 'mock-code', 'device');
    const rejected = expect(pending).rejects.toThrow('timed out');
    expect(fetchPort.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect((fetchPort.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
  });

  it('bounds JSON body reading and cancels outstanding work without leaking input', async () => {
    vi.useFakeTimers();
    const response = new Response('{}');
    vi.spyOn(response, 'json').mockImplementation(() => new Promise(() => {}));
    const fetchPort = vi.fn(async () => response);
    const controller = new AbortController();
    const pending = createPublicLinkApi(fetchPort as typeof fetch, { signal: controller.signal }).pair('http://127.0.0.1', 'private-fixture-code', 'device');
    const rejected = expect(pending).rejects.toThrow('canceled');
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a hung response body and ignores unsafe error codes', async () => {
    vi.useFakeTimers();
    const response = new Response('{}');
    vi.spyOn(response, 'json').mockImplementation(() => new Promise(() => {}));
    const pending = createPublicLinkApi(vi.fn(async () => response), { timeoutMs: 20 }).pair('http://127.0.0.1', 'code', 'device');
    const rejected = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(20); await rejected;
    const unsafe = createPublicLinkApi(vi.fn(async () => new Response(JSON.stringify({ code: '\u001b[2Jsecret' }), { status: 400 })));
    await expect(unsafe.pair('http://127.0.0.1', 'code', 'device')).rejects.toThrow('failed (400)');
  });

  it('does not forward a real pairing request through an HTTP 307 redirect', async () => {
    let redirected = false;
    const server = createServer((request, response) => {
      if (request.url === '/sink') { redirected = true; response.end('{}'); return; }
      response.writeHead(307, { location: '/sink' }).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server failed to bind');
    try {
      await expect(createPublicLinkApi().pair(`http://127.0.0.1:${address.port}`, 'fixture-code', 'fixture')).rejects.toThrow('unreachable');
      expect(redirected).toBe(false);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
