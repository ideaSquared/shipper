import { freezeFailure } from "./freeze.js";
import { environmentOf } from "./manifest.js";
// A commit older than what is live would undo newer work, e.g. when an old CI run is re-run.
export function staleFailure(sha, environment, live, product) {
    if (!live)
        return undefined;
    const short = sha.slice(0, 7);
    const liveShort = live.sha.slice(0, 7);
    const rollback = product ? `ship rollback ${product} ${environment}` : 'ship rollback';
    if (live.relation === 'behind') {
        return `${short} is older than ${liveShort}, which is live on ${environment}. If an old run was re-run, deploy the latest commit instead. To go back on purpose, use ${rollback}.`;
    }
    if (live.relation === 'diverged') {
        return `${short} is not built on ${liveShort}, which is live on ${environment}. Deploy the default branch's latest commit instead.`;
    }
    return undefined;
}
// What a deploy may do to what is live: a deploy must not go back in time; a rollback must, but only
// to a commit that was live in this environment before.
export function liveFailure(facts, environment) {
    if (!facts.rollback)
        return staleFailure(facts.sha, environment, facts.live, facts.product);
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
export function checkProblems(names, runs) {
    const verdicts = names.map((name) => checkVerdict(name, runs));
    return {
        failures: verdicts.flatMap((verdict) => (verdict.failure ? [verdict.failure] : [])),
        waiting: verdicts.flatMap((verdict) => (verdict.waiting ? [verdict.waiting] : [])),
    };
}
export function evaluateGate(manifest, environment, facts) {
    const env = environmentOf(manifest, environment);
    const short = facts.sha.slice(0, 7);
    const checks = checkProblems(manifest.checks, facts.checkRuns);
    const failures = [
        facts.onDefaultBranch
            ? undefined
            : `${short} is not on ${facts.defaultBranch}. Merge it to ${facts.defaultBranch} first: only the default branch deploys.`,
        facts.rollback ? undefined : freezeFailure(facts.freeze, environment, manifest.product),
        liveFailure({ ...facts, product: manifest.product }, environment),
        ...checks.failures,
        ...env.requires
            .filter((required) => !facts.deployedTo.includes(required))
            .map((required) => `${short} has not been deployed successfully to ${required}. Deploy it to ${required} first (ship deploy ${manifest.product} ${required}).`),
    ].filter((failure) => failure !== undefined);
    return { ok: failures.length === 0, failures, waiting: checks.waiting };
}
