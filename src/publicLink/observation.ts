/** Existing Central summary wire format. No message, identity or error text is retained. */
export interface PublicLinkObservation {
  readonly schemaVersion: 1;
  readonly kind: 'runtime-task-summary';
  readonly observedAt: string;
  readonly outcome: 'succeeded' | 'failed' | 'timed-out';
  readonly durationMs?: number;
  readonly timing: Partial<Record<'queueMs' | 'claimToCodexStartMs' | 'codexStartToFirstFeedbackMs' | 'codexStartToTerminalMs' | 'finalOutputToTerminalMs' | 'terminalToReceiptMs', number>>;
  readonly completion: 'accepted' | 'rejected';
  readonly failureCategory?: 'runner-failed' | 'completion-failed' | 'lease-lost' | 'codex-maximum-duration-timeout';
}

export function createPublicLinkObservation(claimedAt: number, queueMs?: number, now: () => number = Date.now) {
  let codexStart: number | undefined, firstFeedback: number | undefined, terminal: number | undefined, finalOutput: number | undefined;
  const duration = (start: number | undefined, end: number | undefined) => start === undefined || end === undefined
    || !Number.isSafeInteger(end - start) || end < start || end - start > 86_400_000 ? undefined : end - start;
  return {
    start() { codexStart ??= now(); },
    lifecycle(stage: string) {
      if (stage === 'agent-output' || stage === 'final-output') firstFeedback ??= now();
      if (stage === 'final-output') finalOutput ??= now();
      if (stage === 'turn-completed' || stage === 'turn-failed') terminal ??= now();
    },
    end() { terminal ??= now(); },
    summarize(outcome: PublicLinkObservation['outcome'], completion: PublicLinkObservation['completion'], failureCategory?: PublicLinkObservation['failureCategory']): PublicLinkObservation {
      const at = now();
      const values = { queueMs, claimToCodexStartMs: duration(claimedAt, codexStart), codexStartToFirstFeedbackMs: duration(codexStart, firstFeedback),
        codexStartToTerminalMs: duration(codexStart, terminal), finalOutputToTerminalMs: duration(finalOutput, terminal), terminalToReceiptMs: duration(terminal, at) };
      const timing = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && Number.isSafeInteger(value) && value >= 0 && value <= 86_400_000));
      return { schemaVersion: 1, kind: 'runtime-task-summary', observedAt: new Date(at).toISOString(), outcome,
        ...(duration(claimedAt, at) === undefined ? {} : { durationMs: duration(claimedAt, at) }), timing, completion,
        ...(outcome === 'succeeded' ? {} : { failureCategory: failureCategory ?? 'runner-failed' }) };
    }
  };
}

/** Bounded, best-effort telemetry; never awaited by a question or task settlement. */
export function createPublicObservationSender(send: (sequence: number, observation: PublicLinkObservation) => Promise<void>) {
  let sequence = Date.now(), active = false;
  const queue: PublicLinkObservation[] = [];
  const drain = async () => {
    if (active) return;
    active = true;
    try {
      while (queue.length) {
        const item = queue.shift()!;
        try { await send(++sequence, item); } catch { /* Telemetry cannot change a task outcome. */ }
      }
    } finally { active = false; }
  };
  return { emit(observation: PublicLinkObservation) { if (queue.length < 16) { queue.push(observation); void drain(); } } };
}
