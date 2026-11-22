// Queued deploys: a deploy blocked only by checks still running, or by a `requires` environment this
// commit is being deployed to right now, waits for them instead of failing. Pure logic; the gate
// (main.ts) and the CLI (commands.ts) do the I/O.
import type { GateResult } from './gate.ts';

export type GateDecision = { action: 'proceed' } | { action: 'wait'; checks: string[]; deploying: string[] } | { action: 'fail'; failures: string[] };

export type WaitBudget = { elapsedMs: number; limitMs: number };

// How long the gate polls between looks. Two or three API calls each time keeps a 30-minute wait far
// inside GitHub's hourly limit for a workflow token.
export const POLL_MS = 30_000;

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

// Only waiting blockers left: they can still pass on their own.
export const onlyWaiting = (result: GateResult): boolean => !result.ok && result.hard.length === 0;

// What the things being waited for are, in a few words: "check 'test' and the staging deploy".
export function waitingFor(checks: readonly string[], deploying: readonly string[]): string {
  const parts = [
    ...(checks.length > 0 ? [`${checks.length === 1 ? 'check' : 'checks'} ${checks.map((name) => `'${name}'`).join(', ')}`] : []),
    ...deploying.map((environment) => `the ${environment} deploy`),
  ];
  return parts.length <= 1 ? (parts[0] ?? 'nothing') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) ?? ''}`;
}

// Proceed when the gate passes; fail at once on anything waiting can't fix, when waiting is off
// (limit 0), or when the time is up; otherwise wait.
export function decideGate(result: GateResult, budget: WaitBudget): GateDecision {
  if (result.ok) return { action: 'proceed' };
  if (!onlyWaiting(result) || budget.limitMs <= 0) return { action: 'fail', failures: result.failures };
  if (budget.elapsedMs >= budget.limitMs) {
    const timedOut = `Waited ${formatDuration(budget.elapsedMs)} for ${waitingFor(result.waiting, result.deploying)}, the most this deploy waits. Deploy again once ${result.waiting.length + result.deploying.length === 1 ? 'it passes' : 'they pass'}.`;
    return { action: 'fail', failures: [timedOut, ...result.failures] };
  }
  return { action: 'wait', checks: result.waiting, deploying: result.deploying };
}

export type WaitOptions = {
  limitMs: number;
  pollMs?: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  // Called before each wait, to say what is still running.
  onWait: (decision: Extract<GateDecision, { action: 'wait' }>, elapsedMs: number) => void;
};

// Re-evaluates the gate until it passes, fails or runs out of time. `first` is the gate's first result;
// `refresh` looks again.
export async function waitForGate(
  first: GateResult,
  refresh: () => Promise<GateResult>,
  options: WaitOptions,
): Promise<Exclude<GateDecision, { action: 'wait' }>> {
  const started = options.now();
  const step = async (result: GateResult): Promise<Exclude<GateDecision, { action: 'wait' }>> => {
    const elapsedMs = options.now() - started;
    const decision = decideGate(result, { elapsedMs, limitMs: options.limitMs });
    if (decision.action !== 'wait') return decision;
    options.onWait(decision, elapsedMs);
    // Never sleep past the deadline, so a timeout is reported on time.
    await options.sleep(Math.max(0, Math.min(options.pollMs ?? POLL_MS, options.limitMs - elapsedMs)));
    return step(await refresh());
  };
  return step(first);
}
