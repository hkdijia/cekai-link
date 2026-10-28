import { describe, expect, it } from 'vitest';
import { createPublicLinkObservation, createPublicObservationSender } from './observation.js';

describe('public Link anonymous observations', () => {
  it('measures lifecycle intervals without retaining content or inventing missing first feedback', () => {
    let at = 1000;
    const observed = createPublicLinkObservation(at, 25, () => at);
    at = 1010; observed.start(); at = 1020; observed.lifecycle('agent-output');
    at = 1040; observed.lifecycle('final-output'); at = 1050; observed.lifecycle('turn-completed');
    at = 1060;
    expect(observed.summarize('succeeded', 'accepted')).toMatchObject({ outcome: 'succeeded', durationMs: 60,
      timing: { queueMs: 25, claimToCodexStartMs: 10, codexStartToFirstFeedbackMs: 10, codexStartToTerminalMs: 40, finalOutputToTerminalMs: 10, terminalToReceiptMs: 10 } });
    const incomplete = createPublicLinkObservation(at, NaN, () => at);
    expect(incomplete.summarize('failed', 'rejected')).toMatchObject({ timing: {}, failureCategory: 'runner-failed' });
    expect(JSON.stringify(incomplete.summarize('failed', 'rejected'))).not.toMatch(/taskId|executionId|credential|request|answer|path|stderr/);
  });
  it('bounds an unavailable telemetry sink without delaying tasks or creating parallel requests', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const sender = createPublicObservationSender(async () => { calls++; if (calls === 1) await new Promise<void>(resolve => { release = resolve; }); else throw new Error('unavailable'); });
    const observation = createPublicLinkObservation(Date.now()).summarize('succeeded', 'accepted');
    for (let i = 0; i < 100; i++) sender.emit(observation);
    expect(calls).toBe(1);
    release!();
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(calls).toBe(17);
  });
});
