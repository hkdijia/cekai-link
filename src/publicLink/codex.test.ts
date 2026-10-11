import { describe, expect, it, vi } from 'vitest';
import { createPublicCodexConnection, createPublicCodexRuntime, readPublicCodexInstallation, type PublicCodexConnection } from './codex.js';

function connectionFixture(options: { deferTurnStart?: boolean; emitBeforeTurnStartResponse?: boolean } = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  const listeners = new Set<(method: string, params: unknown) => void>();
  let resolveTurnStart: ((value: unknown) => void) | undefined;
  let closeResolve!: (error?: Error) => void;
  const closed = new Promise<Error | undefined>((resolve) => { closeResolve = resolve; });
  const emitTurnEvents = () => {
    for (const listener of listeners) {
      listener('turn/started', { threadId: 'thread', turn: { id: 'turn', status: 'inProgress' } });
      listener('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'item', type: 'agentMessage', phase: 'final_answer', text: 'exact answer' } });
      listener('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
    }
  };
  const connection: PublicCodexConnection = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'initialize') return {};
      if (method === 'thread/start') return { thread: { id: 'thread' } };
      if (method === 'turn/start') {
        if (options.emitBeforeTurnStartResponse) emitTurnEvents();
        else if (!options.deferTurnStart) queueMicrotask(emitTurnEvents);
        if (options.deferTurnStart) return await new Promise((resolve) => { resolveTurnStart = resolve; });
        return { turn: { id: 'turn' } };
      }
      return {};
    },
    async notify() {},
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    closed,
    async close() { closeResolve(); }
  };
  return { connection, calls, resolveTurnStart: () => resolveTurnStart?.({ turn: { id: 'turn' } }) };
}

describe('public Link Codex adapter', () => {
  it('checks the exact executable and Node launcher without starting a model or reading auth', () => {
    expect(readPublicCodexInstallation({ executable: process.execPath, prefixArgs: [] })).toBe('found');
    expect(readPublicCodexInstallation({ executable: process.execPath, prefixArgs: ['missing-codex-launcher-fixture.js'] })).toBe('missing');
    expect(readPublicCodexInstallation({ executable: 'missing-codex-fixture-command', prefixArgs: [] })).toBe('missing');
  });
  it('pins read-only sandbox and never-approval while forwarding the question unchanged', async () => {
    const fixture = connectionFixture();
    const runtime = createPublicCodexRuntime({ connect: vi.fn(async () => fixture.connection) });
    await expect(runtime.runTurn({ workspaceKey: 'workspace', bindingRef: 'binding', cwd: '/workspace', request: 'raw question', timeoutMs: 2_000 }))
      .resolves.toBe('exact answer');
    const thread = fixture.calls.find((call) => call.method === 'thread/start')?.params;
    const turn = fixture.calls.find((call) => call.method === 'turn/start')?.params;
    expect(thread).toMatchObject({ cwd: '/workspace', sandbox: 'read-only', approvalPolicy: 'never' });
    expect(turn.input[0].text).toBe('raw question');
    expect(thread.developerInstructions).toContain('只读');
  });

  it('reuses one Codex thread per registered workspace but starts a new turn', async () => {
    const fixture = connectionFixture();
    const runtime = createPublicCodexRuntime({ connect: async () => fixture.connection });
    await runtime.runTurn({ workspaceKey: 'workspace', bindingRef: 'binding', cwd: '/workspace', request: 'first', timeoutMs: 2_000 });
    await runtime.runTurn({ workspaceKey: 'workspace', bindingRef: 'binding', cwd: '/workspace', request: 'second', timeoutMs: 2_000 });
    expect(fixture.calls.filter((call) => call.method === 'thread/start')).toHaveLength(1);
    expect(fixture.calls.filter((call) => call.method === 'turn/start')).toHaveLength(2);
  });

  it('buffers notifications emitted before the turn/start response identifies the turn', async () => {
    const fixture = connectionFixture({ emitBeforeTurnStartResponse: true });
    const runtime = createPublicCodexRuntime({ connect: async () => fixture.connection });
    await expect(runtime.runTurn({ workspaceKey: 'workspace', bindingRef: 'binding', cwd: '/workspace', request: 'question', timeoutMs: 2_000 }))
      .resolves.toBe('exact answer');
  });

  it('interrupts a turn when cancellation precedes the turn/start response', async () => {
    const fixture = connectionFixture({ deferTurnStart: true });
    const runtime = createPublicCodexRuntime({ connect: async () => fixture.connection });
    const controller = new AbortController();
    const pending = runtime.runTurn({ workspaceKey: 'workspace', bindingRef: 'binding', cwd: '/workspace', request: 'question', timeoutMs: 2_000, signal: controller.signal });
    await vi.waitFor(() => expect(fixture.calls.some((call) => call.method === 'turn/start')).toBe(true));
    controller.abort(new Error('owner canceled'));
    await expect(pending).rejects.toThrow('owner canceled');
    fixture.resolveTurnStart();
    await vi.waitFor(() => expect(fixture.calls.some((call) => call.method === 'turn/interrupt')).toBe(true));
  });

  it('isolates different Central conversations even when their workspace is identical', async () => {
    const fixture = connectionFixture();
    const runtime = createPublicCodexRuntime({ connect: async () => fixture.connection });
    for (const bindingRef of ['conversation-one', 'conversation-two', 'conversation-one']) {
      await runtime.runTurn({ workspaceKey: 'workspace', bindingRef, cwd: '/workspace', request: 'question', timeoutMs: 2_000 });
    }
    expect(fixture.calls.filter((call) => call.method === 'thread/start')).toHaveLength(2);
    await runtime.close();
  });

  it('allows a new isolated attempt after the owned connection failed to start', async () => {
    const fixture = connectionFixture();
    const connect = vi.fn().mockRejectedValueOnce(new Error('fixture startup failure')).mockResolvedValue(fixture.connection);
    const runtime = createPublicCodexRuntime({ connect });
    const input = { workspaceKey: 'workspace', bindingRef: 'binding', cwd: '/workspace', request: 'question', timeoutMs: 2_000 };
    await expect(runtime.runTurn(input)).rejects.toThrow('fixture startup failure');
    await expect(runtime.runTurn(input)).resolves.toBe('exact answer');
    expect(connect).toHaveBeenCalledTimes(2);
    await runtime.close();
  });

  it('drains a real child stderr pipe without retaining data, then stops only that child', async () => {
    const script = `process.stderr.write('x'.repeat(4*1024*1024),()=>{require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);process.stdout.write(JSON.stringify({id:message.id,result:{ready:true}})+'\\n');});});`;
    const connection = await createPublicCodexConnection({ executable: process.execPath, args: ['-e', script] }, 500);
    try { await expect(connection.request('fixture', {})).resolves.toEqual({ ready: true }); }
    finally { await connection.close(); }
  }, 10_000);

  it.skipIf(process.platform === 'win32')('bounds POSIX shutdown when the owned child ignores SIGTERM', async () => {
    const script = `process.on('SIGTERM',()=>{});require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);process.stdout.write(JSON.stringify({id:message.id,result:{}})+'\\n');});`;
    const connection = await createPublicCodexConnection({ executable: process.execPath, args: ['-e', script] }, 100);
    try { await connection.request('fixture', {}); }
    finally { await connection.close(); }
    await expect(connection.closed).resolves.toBeInstanceOf(Error);
  });
});
