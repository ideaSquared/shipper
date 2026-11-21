import { freezeFailure } from "./freeze.js";
import { environmentOf } from "./manifest.js";
// A commit older than what is live would undo newer work, e.g. when an old CI run is re-run.
export function staleFailure(sha, environment, live) {
    if (!live)
        return undefined;
    const short = sha.slice(0, 7);
    const liveShort = live.sha.slice(0, 7);
    if (live.relation === 'behind')
        return `${short} is older than ${liveShort}, which is live on ${environment}`;
    if (live.relation === 'diverged')
        return `${short} is not built on ${liveShort}, which is live on ${environment}`;
    return undefined;
}
// What a deploy may do to what is live: a deploy must not go back in time; a rollback must, but only
// to a commit that was live in this environment before.
export function liveFailure(facts, environment) {
    if (!facts.rollback)
        return staleFailure(facts.sha, environment, facts.live);
    if (facts.deployedTo.includes(environment))
        return undefined;
    return `${facts.sha.slice(0, 7)} was never live on ${environment}, so it can't be a rollback target`;
}
function checkVerdict(name, runs) {
    const matching = runs.filter((run) => run.name === name);
    if (matching.length === 0) {
        return { failure: `check '${name}' has not run on this commit. Check the commit is on the default branch, then deploy again.` };
    }
    if (matching.some((run) => run.status === 'completed' && run.conclusion === 'success'))
        return {};
    if (matching.some((run) => run.status !== 'completed')) {
        return { failure: `check '${name}' is still running, so its result is not known yet. Deploy again once it passes.`, waiting: name };
    }
    return { failure: `check '${name}' did not pass. Open the check to see why: fix the code, or re-run the check if it was cancelled or timed out. A deploy can't override it.` };
}
export function evaluateGate(manifest, environment, facts) {
    const env = environmentOf(manifest, environment);
    const short = facts.sha.slice(0, 7);
    const verdicts = manifest.checks.map((name) => checkVerdict(name, facts.checkRuns));
    const failures = [
        facts.onDefaultBranch ? undefined : `${short} is not on ${facts.defaultBranch}`,
        facts.rollback ? undefined : freezeFailure(facts.freeze, environment),
        liveFailure(facts, environment),
        ...verdicts.map((verdict) => verdict.failure),
        ...env.requires
            .filter((required) => !facts.deployedTo.includes(required))
            .map((required) => `${short} has not been deployed successfully to ${required}`),
    ].filter((failure) => failure !== undefined);
    const waiting = verdicts.flatMap((verdict) => (verdict.waiting ? [verdict.waiting] : []));
    return { ok: failures.length === 0, failures, waiting };
}
