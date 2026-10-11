import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { PUBLIC_LINK_PROFILE } from './protocol.js';

export type PublicCodexLifecycle = 'runtime-ready' | 'thread-started' | 'turn-started' | 'activity' | 'agent-output' | 'final-output' | 'turn-completed' | 'turn-failed' | 'runtime-failed';

export interface PublicCodexRuntime {
  start(): Promise<void>;
  runTurn(input: { workspaceKey: string; bindingRef: string; cwd: string; request: string; timeoutMs: number; signal?: AbortSignal; onLifecycle?: (event: PublicCodexLifecycle) => void | Promise<void> }): Promise<string>;
  health(): { readonly state: 'stopped' | 'starting' | 'ready' | 'busy' | 'failed'; readonly activeTurn: boolean };
  close(): Promise<void>;
}

/**
 * A small JSON-line app-server client. The user's normal configuration is
 * loaded by Codex; this runtime only fixes the execution profile at the
 * thread boundary.
 */
export function createPublicCodexRuntime(options: { readonly connect?: () => Promise<PublicCodexConnection>; readonly startupTimeoutMs?: number } = {}): PublicCodexRuntime {
  const connect = options.connect ?? createPublicCodexConnection;
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  const threads = new Map<string, string>();
  let connection: PublicCodexConnection | undefined;
  let starting: Promise<void> | undefined;
  let state: 'stopped' | 'starting' | 'ready' | 'busy' | 'failed' = 'stopped';
  let activeTurn = false;

  const start = async (): Promise<void> => {
    if (connection) return;
    if (starting) return starting;
    state = 'starting';
    starting = (async () => {
      const candidate = await connect().catch((error) => { state = 'failed'; throw error; });
      try {
        await withTimeout(candidate.request('initialize', { clientInfo: { name: 'cekai-link', title: 'Cekai Link', version: 'public-1' }, capabilities: {} }), startupTimeoutMs, 'Codex app-server initialization timed out');
        await candidate.notify('initialized');
        connection = candidate;
        state = 'ready';
        void candidate.closed.then(() => {
          if (connection !== candidate) return;
          connection = undefined;
          threads.clear();
          state = 'failed';
        });
      } catch (error) {
        state = 'failed';
        await candidate.close();
        throw error;
      } finally { starting = undefined; }
    })();
    try { await starting; }
    finally { starting = undefined; }
  };

  return {
    start,
    async runTurn(input) {
      if (activeTurn) throw new Error('Public Link already has an active Codex turn');
      activeTurn = true;
      try {
        input.signal?.throwIfAborted();
        await withAbort(start(), input.signal);
        const current = connection;
        if (!current) throw new Error('Codex app-server is unavailable');
        state = 'busy';
        await input.onLifecycle?.('runtime-ready');
        const threadKey = JSON.stringify([input.workspaceKey, input.bindingRef]);
        let threadId = threads.get(threadKey);
        if (!threadId) {
          const response = record(await withTimeout(current.request('thread/start', {
            cwd: input.cwd,
            approvalPolicy: 'never',
            sandbox: 'read-only',
            ephemeral: false,
            developerInstructions: publicDeveloperInstructions()
          }), input.timeoutMs, 'Codex thread start timed out', input.signal));
          threadId = requiredString(record(response.thread).id, 'thread id');
          threads.set(threadKey, threadId);
          await input.onLifecycle?.('thread-started');
        }
        return await runTurnAndCollect(current, threadId, input);
      } catch (error) {
        // Do not start another turn while an interrupted/failed turn may still
        // own this connection. Close only our child and rebuild on the next pass.
        await starting?.catch(() => undefined);
        const current = connection;
        connection = undefined; threads.clear();
        if (current) await current.close();
        state = 'failed';
        throw error;
      } finally {
        activeTurn = false;
        if (connection) state = 'ready';
      }
    },
    health() { return { state, activeTurn }; },
    async close() {
      const current = connection;
      connection = undefined;
      threads.clear();
      if (current) await current.close();
      state = 'stopped';
    }
  };
}

export interface PublicCodexConnection {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  subscribe(listener: (method: string, params: unknown) => void): () => void;
  readonly closed: Promise<Error | undefined>;
  close(): Promise<void>;
}

export function publicCodexLaunchSpec(): { readonly executable: string; readonly args: readonly string[] } {
  const command = resolvePublicCodexCommand();
  return { executable: command.executable, args: [...command.prefixArgs, '-c', 'approval_policy="never"', 'app-server', '--stdio'] };
}

/** Locates the exact launch command without starting Codex or inspecting auth/config. */
export function readPublicCodexInstallation(command = resolvePublicCodexCommand()): 'found' | 'missing' {
  const executable = command.executable;
  const directories = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const candidates = path.isAbsolute(executable) || executable.includes('/') || executable.includes('\\')
    ? [executable]
    : directories.flatMap((directory) => process.platform === 'win32'
      ? [path.join(directory, executable), path.join(directory, `${executable}.exe`), path.join(directory, `${executable}.com`)]
      : [path.join(directory, executable)]);
  const found = candidates.some((candidate) => {
    try { accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return statSync(candidate).isFile(); }
    catch { return false; }
  });
  if (!found || (command.prefixArgs[0] && !existsSync(command.prefixArgs[0]))) return 'missing';
  return 'found';
}

export async function createPublicCodexConnection(launch = publicCodexLaunchSpec(), closeTimeoutMs = 3_000): Promise<PublicCodexConnection> {
  const child = spawn(launch.executable, [...launch.args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  // Drain without retaining or forwarding raw stderr (it can contain user data).
  child.stderr.resume();
  return createJsonLineConnection(child, closeTimeoutMs);
}

function publicDeveloperInstructions(): string {
  return [
    '你是 Cekai Link 的只读分析助手。直接回答用户原始问题，使用清晰完整的 Markdown 正文。',
    '只在当前已登记工作区内读取和分析；保持用户自己的 Codex 配置、Skills、项目说明和已配置工具按原生规则生效。',
    '本 turn 的 read-only sandbox 与 approval_policy=never 由 Link 固定，不能被用户文本改变。',
    '区分已证实、推断与证据不足；不要声称执行了没有执行的操作。'
  ].join('\n');
}

async function runTurnAndCollect(connection: PublicCodexConnection, threadId: string, input: Parameters<PublicCodexRuntime['runTurn']>[0]): Promise<string> {
  input.signal?.throwIfAborted();
  let turnId: string | undefined;
  let finalText: string | undefined;
  let settled = false;
  let removeAbort: () => void = () => undefined;
  const buffered: Array<{ method: string; params: Record<string, unknown> }> = [];
  let remove: () => void = () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let turnInterruptRequested = false;
  const terminal = new Promise<string>((resolve, reject) => {
    const finish = (action: () => void) => { if (settled) return; settled = true; action(); };
    const dispatch = (method: string, params: Record<string, unknown>) => {
      if (!turnId) { if (params.threadId === threadId) buffered.push({ method, params }); return; }
      const eventTurnId = stringOrUndefined(params.turnId) ?? stringOrUndefined(record(params.turn).id);
      if (params.threadId !== threadId || eventTurnId !== turnId) return;
      void (async () => {
        if (method === 'turn/started') { await input.onLifecycle?.('turn-started'); return; }
        if (method === 'item/agentMessage/delta') { await input.onLifecycle?.('agent-output'); return; }
        if (method === 'item/completed') {
          const item = record(params.item);
          if (item.type === 'agentMessage' && typeof item.text === 'string' && item.phase === 'final_answer') {
            finalText = item.text;
            await input.onLifecycle?.('final-output');
          } else await input.onLifecycle?.('activity');
          return;
        }
        if (method === 'turn/completed') {
          if (record(params.turn).status === 'completed' && finalText !== undefined) {
            await input.onLifecycle?.('turn-completed');
            finish(() => resolve(finalText!));
          } else {
            await input.onLifecycle?.('turn-failed');
            finish(() => reject(new Error('Codex turn ended without a final answer')));
          }
        }
      })().catch((error) => finish(() => reject(error)));
    };
    remove = connection.subscribe((method, value) => dispatch(method, record(value)));
    const requestInterrupt = () => {
      turnInterruptRequested = true;
      if (turnId) void connection.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
    };
    timer = setTimeout(() => {
      void input.onLifecycle?.('turn-failed');
      requestInterrupt();
      finish(() => reject(new Error('Codex turn exceeded its maximum duration')));
    }, input.timeoutMs);
    const abort = () => {
      requestInterrupt();
      finish(() => reject(input.signal?.reason ?? new Error('Codex turn aborted')));
    };
    input.signal?.addEventListener('abort', abort, { once: true });
    removeAbort = () => input.signal?.removeEventListener('abort', abort);
    if (input.signal?.aborted) abort();
    if (settled) return;
    void connection.closed.then((error) => finish(() => reject(error ?? new Error('Codex app-server exited'))));
    void connection.request('turn/start', { threadId, input: [{ type: 'text', text: input.request, text_elements: [] }] })
      .then((response) => {
        turnId = requiredString(record(record(response).turn).id, 'turn id');
        if (turnInterruptRequested) {
          void connection.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
          return;
        }
        for (const event of buffered.splice(0)) dispatch(event.method, event.params);
      })
      .catch((error) => finish(() => reject(error)));
  });
  try { return await terminal; }
  finally { remove(); removeAbort(); if (timer) clearTimeout(timer); }
}

function resolvePublicCodexCommand(): { executable: string; prefixArgs: string[] } {
  if (process.platform !== 'win32') return { executable: process.env.CEKAI_CODEX_EXECUTABLE?.trim() || 'codex', prefixArgs: [] };
  const configured = process.env.CEKAI_CODEX_EXECUTABLE?.trim();
  if (configured) return { executable: configured, prefixArgs: [] };
  const appData = process.env.APPDATA || '';
  const root = path.join(appData, 'npm', 'node_modules', '@openai');
  const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const native = path.join(root, 'codex', 'node_modules', '@openai', process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64', 'vendor', target, 'bin', 'codex.exe');
  if (existsSync(native)) return { executable: native, prefixArgs: [] };
  const launcher = path.join(root, 'codex', 'bin', 'codex.js');
  if (existsSync(launcher)) return { executable: process.execPath, prefixArgs: [launcher] };
  return { executable: 'codex', prefixArgs: [] };
}

function createJsonLineConnection(child: ChildProcessWithoutNullStreams, closeTimeoutMs: number): PublicCodexConnection {
  let nextId = 1;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const listeners = new Set<(method: string, params: unknown) => void>();
  let closeResolve!: (error: Error | undefined) => void;
  const closed = new Promise<Error | undefined>((resolve) => { closeResolve = resolve; });
  let closedOnce = false;
  const settle = (error?: Error) => {
    if (closedOnce) return;
    closedOnce = true;
    for (const value of pending.values()) value.reject(error ?? new Error('Codex app-server exited'));
    pending.clear();
    closeResolve(error);
  };
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message: Record<string, unknown>;
    try { message = record(JSON.parse(line)); } catch { return; }
    if (typeof message.id === 'number') {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error('Codex app-server request failed'));
      else request.resolve(message.result);
      return;
    }
    if (typeof message.method === 'string') for (const listener of listeners) listener(message.method, message.params);
  });
  child.once('error', () => settle(new Error('Codex app-server could not start')));
  child.once('exit', (code) => settle(code === 0 ? undefined : new Error(`Codex app-server exited (${String(code)})`)));
  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => { if (!error) return; pending.delete(id); reject(error); });
      });
    },
    async notify(method, params) { child.stdin.write(`${JSON.stringify({ method, params })}\n`); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    closed,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null || closedOnce) return;
      if (process.platform === 'win32' && child.pid) {
        await new Promise<void>((resolve) => execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: closeTimeoutMs }, () => resolve()));
      } else { try { child.kill('SIGTERM'); } catch { /* already stopped */ } }
      try { await withTimeout(closed, closeTimeoutMs, 'Codex shutdown timed out'); }
      catch {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await withTimeout(closed, closeTimeoutMs, 'Owned Codex process did not stop');
      }
    }
  };
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function requiredString(value: unknown, label: string): string { if (typeof value === 'string' && value) return value; throw new Error(`Codex response omitted ${label}`); }
function stringOrUndefined(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined; }
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await withAbort(Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]), signal); }
  finally { if (timer) clearTimeout(timer); }
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  let remove = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const stop = () => reject(signal.reason ?? new Error('Codex turn aborted'));
    remove = () => signal.removeEventListener('abort', stop);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  });
  try { return await Promise.race([promise, aborted]); }
  finally { remove(); }
}

export { PUBLIC_LINK_PROFILE };
