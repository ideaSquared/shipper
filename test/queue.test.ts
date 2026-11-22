import { describe, expect, it } from 'vitest';
import type { GateResult } from '../src/gate.ts';
import { decideGate, waitForGate, waitingFor } from '../src/queue.ts';

const RUNNING = "check 'test' is still running, so its result is not known yet. Deploy again once it passes.";
const FAILED =
  "check 'lint' did not pass. Open the check to see why: fix the code, or re-run the check if it was cancelled or timed out. A deploy can't override it.";

const passed: GateResult = { ok: true, failures: [], waiting: [], deploying: [], hard: [] };
const waiting: GateResult = { ok: false, failures: [RUNNING], waiting: ['test'], deploying: [], hard: [] };
const failed: GateResult = { ok: false, failures: [FAILED], waiting: [], deploying: [], hard: [FAILED] };
const mixed: GateResult = { ok: false, failures: [RUNNING, FAILED], waiting: ['test'], deploying: [], hard: [FAILED] };

const budget = { elapsedMs: 60_000, limitMs: 30 * 60_000 };

describe('decideGate', () => {
  it('proceeds when the gate passes', () => {
    expect(decideGate(passed, budget)).toEqual({ action: 'proceed' });
  });

  it('waits when the only blockers are checks still running or a requires deploy under way', () => {
    expect(decideGate(waiting, budget)).toEqual({ action: 'wait', checks: ['test'], deploying: [] });
    const deploying: GateResult = { ok: false, failures: ['abcdef1 is being deployed to staging right now.'], waiting: [], deploying: ['staging'], hard: [] };
    expect(decideGate(deploying, budget)).toEqual({ action: 'wait', checks: [], deploying: ['staging'] });
  });

  it('fails at once when a check failed', () => {
    expect(decideGate(failed, budget)).toEqual({ action: 'fail', failures: [FAILED] });
  });

  it('fails at once when a hard failure comes with checks still running', () => {
    expect(decideGate(mixed, budget)).toEqual({ action: 'fail', failures: [RUNNING, FAILED] });
  });

  it('fails when the time is up, saying what it waited for', () => {
    expect(decideGate(waiting, { elapsedMs: 30 * 60_000, limitMs: 30 * 60_000 })).toEqual({
      action: 'fail',
      failures: ["Waited 30m 0s for check 'test', the most this deploy waits. Deploy again once it passes.", RUNNING],
    });
  });

  it('fails at once, as before, when waiting is off', () => {
    expect(decideGate(waiting, { elapsedMs: 0, limitMs: 0 })).toEqual({ action: 'fail', failures: [RUNNING] });
  });
});

describe('waitingFor', () => {
  it('names the checks and deploys in a few words', () => {
    expect(waitingFor(['test'], [])).toBe("check 'test'");
    expect(waitingFor(['test', 'e2e'], ['staging'])).toBe("checks 'test', 'e2e' and the staging deploy");
  });
});

describe('waitForGate', () => {
  const clock = () => {
    let now = 0;
    return { now: () => now, sleep: async (ms: number) => void (now += ms) };
  };

  it('looks again until the checks pass, saying what it waits for each time', async () => {
    const time = clock();
    const results = [waiting, passed];
    const seen: string[] = [];
    const outcome = await waitForGate(waiting, async () => results.shift() ?? passed, {
      limitMs: 30 * 60_000,
      pollMs: 30_000,
      ...time,
      onWait: (decision, elapsedMs) => seen.push(`${decision.checks.join(',')} @ ${elapsedMs}`),
    });
    expect(outcome).toEqual({ action: 'proceed' });
    expect(seen).toEqual(['test @ 0', 'test @ 30000']);
  });

  it('stops waiting as soon as a check fails', async () => {
    const time = clock();
    const outcome = await waitForGate(waiting, async () => failed, { limitMs: 30 * 60_000, ...time, onWait: () => {} });
    expect(outcome).toEqual({ action: 'fail', failures: [FAILED] });
    expect(time.now()).toBe(30_000);
  });

  it('gives up at the time limit, never sleeping past it', async () => {
    const time = clock();
    const outcome = await waitForGate(waiting, async () => waiting, { limitMs: 70_000, pollMs: 30_000, ...time, onWait: () => {} });
    expect(outcome.action).toBe('fail');
    expect(outcome.action === 'fail' ? outcome.failures[0] : '').toMatch(/^Waited 1m 10s for check 'test'/);
    expect(time.now()).toBe(70_000);
  });
});
