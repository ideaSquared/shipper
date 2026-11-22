import { freezeFailure, type Freeze } from './freeze.ts';
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
  // Environments a deploy of this SHA is under way in right now (started, not finished).
  deployingTo?: readonly string[];
  // Putting back a commit that was live before: it may be older than what is live now.
  rollback?: boolean;
  // What is live in the target environment, and how this SHA relates to it (GitHub compare status
  // of live...sha: "ahead", "behind", "identical" or "diverged").
  live?: { sha: string; relation: string };
  // The product's `ship freeze`, if one is set. A rollback is never blocked by it.
  freeze?: Freeze;
};

// A commit older than what is live would undo newer work, e.g. when an old CI run is re-run.
export function staleFailure(sha: string, environment: string, live: GateFacts['live'], product?: string): string | undefined {
  if (!live) return undefined;
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
export function liveFailure(
  facts: Pick<GateFacts, 'sha' | 'live' | 'deployedTo' | 'rollback'> & { product?: string },
  environment: string,
): string | undefined {
  if (!facts.rollback) return staleFailure(facts.sha, environment, facts.live, facts.product);
  if (facts.deployedTo.includes(environment)) return undefined;
  return `${facts.sha.slice(0, 7)} was never live on ${environment}, so it can't be a rollback target`;
}

// `waiting` names the checks still running and `deploying` the `requires` environments this commit is
// being deployed to right now: both can still turn into a pass. `hard` are the failures that can't.
export type GateResult = { ok: boolean; failures: string[]; waiting: string[]; deploying: string[]; hard: string[] };

type CheckVerdict = { failure?: string; waiting?: string };

// Where one named check stands on a commit. A passing re-run beats an earlier failure.
export function checkState(name: string, runs: readonly CheckRun[]): 'passed' | 'running' | 'failed' | 'missing' {
  const matching = runs.filter((run) => run.name === name);
  if (matching.length === 0) return 'missing';
  if (matching.some((run) => run.status === 'completed' && run.conclusion === 'success')) return 'passed';
  if (matching.some((run) => run.status !== 'completed')) return 'running';
  return 'failed';
}

function checkVerdict(name: string, runs: readonly CheckRun[]): CheckVerdict {
  const state = checkState(name, runs);
  if (state === 'missing') {
    return { failure: `check '${name}' has not run on this commit. Check the commit is on the default branch, then deploy again.` };
  }
  if (state === 'passed') return {};
  if (state === 'running') {
    return { failure: `check '${name}' is still running, so its result is not known yet. Deploy again once it passes.`, waiting: name };
  }
  return {
    failure: `check '${name}' did not pass. Open the check to see why: fix the code, or re-run the check if it was cancelled or timed out. A deploy can't override it.`,
  };
}

export function checkProblems(names: readonly string[], runs: readonly CheckRun[]): { failures: string[]; waiting: string[] } {
  const verdicts = names.map((name) => checkVerdict(name, runs));
  return {
    failures: verdicts.flatMap((verdict) => (verdict.failure ? [verdict.failure] : [])),
    waiting: verdicts.flatMap((verdict) => (verdict.waiting ? [verdict.waiting] : [])),
  };
}

type Problem = { message: string; waits: boolean };

export function evaluateGate(manifest: Manifest, environment: string, facts: GateFacts): GateResult {
  const env = environmentOf(manifest, environment);
  const short = facts.sha.slice(0, 7);
  const hard = (message: string | undefined): Problem[] => (message ? [{ message, waits: false }] : []);
  const missing = env.requires.filter((required) => !facts.deployedTo.includes(required));
  const deploying = missing.filter((required) => facts.deployingTo?.includes(required) ?? false);
  const problems: Problem[] = [
    ...hard(
      facts.onDefaultBranch
        ? undefined
        : `${short} is not on ${facts.defaultBranch}. Merge it to ${facts.defaultBranch} first: only the default branch deploys.`,
    ),
    ...hard(facts.rollback ? undefined : freezeFailure(facts.freeze, environment, manifest.product)),
    ...hard(liveFailure({ ...facts, product: manifest.product }, environment)),
    ...manifest.checks.flatMap((name): Problem[] => {
      const verdict = checkVerdict(name, facts.checkRuns);
      return verdict.failure ? [{ message: verdict.failure, waits: verdict.waiting !== undefined }] : [];
    }),
    ...missing.map((required): Problem => {
      if (deploying.includes(required)) {
        return { message: `${short} is being deployed to ${required} right now. ${environment} can follow once that deploy succeeds.`, waits: true };
      }
      return {
        message: `${short} has not been deployed successfully to ${required}. Deploy it to ${required} first (ship deploy ${manifest.product} ${required}).`,
        waits: false,
      };
    }),
  ];
  const failures = problems.map((problem) => problem.message);
  return {
    ok: failures.length === 0,
    failures,
    waiting: checkProblems(manifest.checks, facts.checkRuns).waiting,
    deploying,
    hard: problems.filter((problem) => !problem.waits).map((problem) => problem.message),
  };
}
