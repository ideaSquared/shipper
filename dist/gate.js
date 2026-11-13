import { environmentOf } from "./manifest.js";
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
        ...manifest.checks.map((name) => checkFailure(name, facts.checkRuns)),
        ...env.requires
            .filter((required) => !facts.deployedTo.includes(required))
            .map((required) => `${short} has not been deployed successfully to ${required}`),
    ].filter((failure) => failure !== undefined);
    return { ok: failures.length === 0, failures };
}
