import { environmentOf, type Manifest } from './manifest.ts';

export type CheckRun = { name: string; status: string; conclusion: string | null };

export type GateFacts = {
  sha: string;
  defaultBranch: string;
  onDefaultBranch: boolean;
  checkRuns: readonly CheckRun[];
  // Environments this SHA has a successful deployment in.
  deployedTo: readonly string[];
};

export type GateResult = { ok: boolean; failures: string[] };

function checkFailure(name: string, runs: readonly CheckRun[]): string | undefined {
  const matching = runs.filter((run) => run.name === name);
  if (matching.length === 0) return `check '${name}' has not run on this commit`;
  if (matching.some((run) => run.status === 'completed' && run.conclusion === 'success')) return undefined;
  if (matching.some((run) => run.status !== 'completed')) return `check '${name}' is still running`;
  return `check '${name}' did not pass`;
}

export function evaluateGate(manifest: Manifest, environment: string, facts: GateFacts): GateResult {
  const env = environmentOf(manifest, environment);
  const short = facts.sha.slice(0, 7);
  const failures = [
    facts.onDefaultBranch ? undefined : `${short} is not on ${facts.defaultBranch}`,
    ...manifest.checks.map((name) => checkFailure(name, facts.checkRuns)),
    ...env.requires
      .filter((required) => !facts.deployedTo.includes(required))
      .map((required) => `${short} has not been deployed successfully to ${required}`),
  ].filter((failure): failure is string => failure !== undefined);
  return { ok: failures.length === 0, failures };
}
