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
function checkFailure(name, runs) {
    const matching = runs.filter((run) => run.name === name);
    if (matching.length === 0)
        return `check '${name}' has not run on this commit`;
    if (matching.some((run) => run.status === 'completed' && run.conclusion === 'success'))
        return undefined;
    if (matching.some((run) => run.status !== 'completed'))
        return `check '${name}' is still running`;
    return `check '${name}' did not pass`;
}
export function evaluateGate(manifest, environment, facts) {
    const env = environmentOf(manifest, environment);
    const short = facts.sha.slice(0, 7);
    const failures = [
        facts.onDefaultBranch ? undefined : `${short} is not on ${facts.defaultBranch}`,
        liveFailure(facts, environment),
        ...manifest.checks.map((name) => checkFailure(name, facts.checkRuns)),
        ...env.requires
            .filter((required) => !facts.deployedTo.includes(required))
            .map((required) => `${short} has not been deployed successfully to ${required}`),
    ].filter((failure) => failure !== undefined);
    return { ok: failures.length === 0, failures };
}
