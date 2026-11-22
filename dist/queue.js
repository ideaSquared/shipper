// How long the gate polls between looks. Two or three API calls each time keeps a 30-minute wait far
// inside GitHub's hourly limit for a workflow token.
export const POLL_MS = 30_000;
export function formatDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
// Only waiting blockers left: they can still pass on their own.
export const onlyWaiting = (result) => !result.ok && result.hard.length === 0;
// What the things being waited for are, in a few words: "check 'test' and the staging deploy".
export function waitingFor(checks, deploying) {
    const parts = [
        ...(checks.length > 0 ? [`${checks.length === 1 ? 'check' : 'checks'} ${checks.map((name) => `'${name}'`).join(', ')}`] : []),
        ...deploying.map((environment) => `the ${environment} deploy`),
    ];
    return parts.length <= 1 ? (parts[0] ?? 'nothing') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) ?? ''}`;
}
// Proceed when the gate passes; fail at once on anything waiting can't fix, when waiting is off
// (limit 0), or when the time is up; otherwise wait.
export function decideGate(result, budget) {
    if (result.ok)
        return { action: 'proceed' };
    if (!onlyWaiting(result) || budget.limitMs <= 0)
        return { action: 'fail', failures: result.failures };
    if (budget.elapsedMs >= budget.limitMs) {
        const timedOut = `Waited ${formatDuration(budget.elapsedMs)} for ${waitingFor(result.waiting, result.deploying)}, the most this deploy waits. Deploy again once ${result.waiting.length + result.deploying.length === 1 ? 'it passes' : 'they pass'}.`;
        return { action: 'fail', failures: [timedOut, ...result.failures] };
    }
    return { action: 'wait', checks: result.waiting, deploying: result.deploying };
}
// Re-evaluates the gate until it passes, fails or runs out of time. `first` is the gate's first result;
// `refresh` looks again.
export async function waitForGate(first, refresh, options) {
    const started = options.now();
    const step = async (result) => {
        const elapsedMs = options.now() - started;
        const decision = decideGate(result, { elapsedMs, limitMs: options.limitMs });
        if (decision.action !== 'wait')
            return decision;
        options.onWait(decision, elapsedMs);
        // Never sleep past the deadline, so a timeout is reported on time.
        await options.sleep(Math.max(0, Math.min(options.pollMs ?? POLL_MS, options.limitMs - elapsedMs)));
        return step(await refresh());
    };
    return step(first);
}
