import { environmentOf, type Manifest } from './manifest.ts';

export type CheckRun = { name: string; status: string; conclusion: string | null };

export type GateFacts = {
  sha: string;
  defaultBranch: string;
  onDefaultBranch: boolean;
  checkRuns: readonly CheckRun[];
  // Environments this SHA has a successful deployment in. For a rollback, this includes the target
  // environment if the SHA was ever live there.
  deployedTo: readonly string[];
  // Putting back a commit that was live before: it may be older than what is live now.
  rollback?: boolean;
  // What is live in the target environment, and how this SHA relates to it (GitHub compare status
  // of live...sha: "ahead", "behind", "identical" or "diverged").
  live?: { sha: string; relation: string };
};

// A commit older than what is live would undo newer work, e.g. when an old CI run is re-run.
export function staleFailure(sha: string, environment: string, live: GateFacts['live']): string | undefined {
  if (!live) return undefined;
  const short = sha.slice(0, 7);
  const liveShort = live.sha.slice(0, 7);
  if (live.relation === 'behind') return `${short} is older than ${liveShort}, which is live on ${environment}`;
  if (live.relation === 'diverged') return `${short} is not built on ${liveShort}, which is live on ${environment}`;
  return undefined;
}

// What a deploy may do to what is live: a deploy must not go back in time; a rollback must, but only
// to a commit that was live in this environment before.
export function liveFailure(
  facts: Pick<GateFacts, 'sha' | 'live' | 'deployedTo' | 'rollback'>,
  environment: string,
): string | undefined {
  if (!facts.rollback) return staleFailure(facts.sha, environment, facts.live);
  if (facts.deployedTo.includes(environment)) return undefined;
  return `${facts.sha.slice(0, 7)} was never live on ${environment}, so it can't be a rollback target`;
}

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
    liveFailure(facts, environment),
    ...manifest.checks.map((name) => checkFailure(name, facts.checkRuns)),
    ...env.requires
      .filter((required) => !facts.deployedTo.includes(required))
      .map((required) => `${short} has not been deployed successfully to ${required}`),
  ].filter((failure): failure is string => failure !== undefined);
  return { ok: failures.length === 0, failures };
}
