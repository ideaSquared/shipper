// What `ship status | diff | log | deploy` do. The CLI wires in GitHub, the terminal and the clock.
import { describeFreeze, freezeFailure, readFreeze, type Freeze } from './freeze.ts';
import { checkProblems, checkState, evaluateGate, type CheckRun } from './gate.ts';
import { GitHubApiError, isAccessError, type DeploymentSummary, type GitHubClient, type JobSummary } from './github.ts';
import { pendingMigrations } from './migrations.ts';
import type { Comparison } from './notify.ts';
import { parseManifest, type Manifest } from './manifest.ts';
import { accessHint, RATE_LIMIT_HINT } from './products.ts';
import { formatDuration, onlyWaiting, waitingFor } from './queue.ts';
import { plain, type Style } from './style.ts';

export { formatDuration } from './queue.ts';

export type Context = {
  client: GitHubClient;
  repo: string;
  manifest: Manifest;
  defaultBranch: string;
  head: string;
  print: (line: string) => void;
  canWrite: boolean;
  timeZone?: string;
  style: Style;
};

export type DeployOptions = {
  yes: boolean;
  wait: boolean;
  redeploy: boolean;
  confirm: (question: string) => Promise<boolean>;
  // Asks for typed text (the product name, before touching production).
  ask: (question: string) => Promise<string>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  pollMs?: number;
  findRunAttempts?: number;
  // Runs `stop` on Ctrl-C while a started run is being followed; returns a function that stops listening.
  onInterrupt?: (stop: () => void) => () => void;
};

export type RollbackOptions = Omit<DeployOptions, 'redeploy'> & { to?: string };

// What starting a workflow and following its run needs.
type FollowOptions = Pick<DeployOptions, 'wait' | 'now' | 'sleep' | 'pollMs' | 'findRunAttempts' | 'onInterrupt'>;

export const DEFAULT_ROLLBACK_WORKFLOW = 'ship-rollback.yml';

const short = (sha: string) => sha.slice(0, 7);

// The environment real users are on. Changing it takes a second, typed confirmation.
const PRODUCTION = 'production';

// The usual yes/no (skipped by --yes), then for production a red warning and the product name
// typed back, which --yes never skips.
async function approve(ctx: Context, env: string, question: string, options: Pick<DeployOptions, 'yes' | 'confirm' | 'ask'>): Promise<boolean> {
  const s = ctx.style;
  if (env === PRODUCTION) {
    ctx.print('');
    ctx.print(s.bad('🚨🚨🚨  PRODUCTION  🚨🚨🚨'));
    ctx.print(s.bad(`This changes what real users of ${ctx.manifest.product} get, as soon as it finishes.`));
    ctx.print('');
  }
  if (!options.yes && !(await options.confirm(question))) return false;
  if (env !== PRODUCTION) return true;
  const typed = await options.ask(`✍️  Type ${s.bold(ctx.manifest.product)} to confirm:`);
  if (typed.trim() === ctx.manifest.product) return true;
  ctx.print(`🙅 ${s.bad(`That isn't ${ctx.manifest.product}.`)}`);
  return false;
}

export async function loadContext(
  client: GitHubClient,
  repo: string,
  print: (line: string) => void,
  canWrite: boolean,
  style: Style = plain,
  timeZone?: string,
): Promise<Context> {
  const defaultBranch = await client.defaultBranch();
  const [head, text] = await Promise.all([client.headSha(defaultBranch), client.readFile('ship.yaml', defaultBranch)]);
  if (text === undefined) throw new Error(`${repo} has no ship.yaml on ${defaultBranch}, so it doesn't deploy with shipper yet.`);
  return { client, repo, manifest: parseManifest(text), defaultBranch, head, print, canWrite, timeZone, style };
}

function formatTime(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(iso));
}

// The environment to act on: the one named, or the only one there is.
export function pickEnvironment(manifest: Manifest, named: string | undefined): string {
  const names = Object.keys(manifest.environments);
  if (named) {
    if (names.includes(named)) return named;
    throw new Error(`No environment '${named}' in ship.yaml. It has: ${names.join(', ')}.`);
  }
  const [only, ...rest] = names;
  if (only && rest.length === 0) return only;
  throw new Error(`Name an environment: ${names.join(', ')}.`);
}

// The product's freeze. GitHub refusing to say (a token without the Variables permission) is not
// a reason to stop: the workflow's gate enforces it either way. A malformed value still throws.
async function freezeOf(ctx: Context): Promise<Freeze | undefined> {
  return readFreeze(ctx.client).catch((error: unknown) => {
    if (!(error instanceof GitHubApiError)) throw error;
    const refused = error.status === 403 || error.status === 404;
    if (!refused || error.rateLimited) ctx.print(`⚠️  ${ctx.style.warn(`Could not check for a freeze: ${error.message}`)}`);
    return undefined;
  });
}

// Tells the user, before they try a deploy, what the gate would stop it for: a check on head that is
// still running or did not pass, and an environment that only takes commits live somewhere else first.
async function warnIfBlocked(ctx: Context, environments: readonly string[]): Promise<void> {
  const { client, manifest, head, style: s } = ctx;
  if (manifest.checks.length > 0) {
    const runs = await client.checkRuns(head).catch((error: unknown) => {
      ctx.print(`⚠️  ${s.warn(`Could not check the default branch head: ${error instanceof Error ? error.message : String(error)}`)}`);
      return undefined;
    });
    const { failures, waiting } = runs ? checkProblems(manifest.checks, runs) : { failures: [], waiting: [] };
    if (failures.length > 0 && waiting.length === failures.length) {
      ctx.print(`⏳ ${s.warn(`${short(head)} can't ship yet, ${waiting.length === 1 ? 'a check is' : 'checks are'} still running:`)}`);
      failures.forEach((failure) => ctx.print(`   • ${s.warn(failure)}`));
      ctx.print(`   ${s.dim(`A deploy started now is queued until ${waiting.length === 1 ? 'it passes' : 'they pass'}.`)}`);
    } else if (failures.length > 0) {
      ctx.print(`⛔ ${s.bad(`${short(head)} would be blocked by the gate:`)}`);
      failures.forEach((failure) => ctx.print(`   • ${s.bad(failure)}`));
    }
  }
  await Promise.all(
    environments.map(async (env) => {
      const requires = manifest.environments[env]?.requires ?? [];
      if (requires.length === 0) return;
      const deployed = await client.deployedTo(head, requires).catch(() => requires);
      const missing = requires.filter((required) => !deployed.includes(required));
      const [first] = missing;
      if (!first) return;
      ctx.print(
        `🔗 ${s.warn(`${env} only takes ${short(head)} once it is live on ${missing.join(' and ')}. Run ship deploy ${manifest.product} ${first} first.`)}`,
      );
    }),
  );
}

// A freeze on this environment, with the reason and how to lift it.
async function warnIfFrozen(ctx: Context, env: string): Promise<void> {
  const frozen = await freezeOf(ctx);
  if (!frozen || !freezeFailure(frozen, env)) return;
  describeFreeze(ctx, frozen).forEach((line) => ctx.print(line));
  ctx.print(`   ${ctx.style.dim(`Lift it with ship unfreeze ${ctx.manifest.product} ${env} when it is safe.`)}`);
}

export async function status(ctx: Context): Promise<number> {
  const { client, manifest, head, style: s } = ctx;
  ctx.print(`🚢 ${s.bold(manifest.product)} ${s.dim(`(${ctx.repo})`)} · ${ctx.defaultBranch} is at ${s.sha(short(head))}`);
  const rows = await Promise.all(
    Object.keys(manifest.environments).map(async (env) => {
      const recent = await client.deployments(env, 20);
      // The newest record that is live: `error` went live but failed its smoke checks (see main.ts), so a
      // newer attempt that failed before deploying, or is still pending, doesn't hide it.
      const latest = recent.find((d) => d.state === 'success' || d.state === 'inactive' || d.state === 'error');
      const name = s.env(env.padEnd(12));
      const smokeFailed =
        latest?.state === 'error'
          ? [
              `   ⚠️  ${s.warn(`${short(latest.sha)} is live but its smoke checks failed. If the release is at fault, run ship rollback ${manifest.product} ${env}.`)}`,
            ]
          : [];
      if (!latest) return { env, lines: [`⚪ ${name} ${s.dim('never deployed')}`], upToDate: false };
      const upToDate = latest.sha === head;
      const behind = upToDate ? s.ok('up to date') : s.warn(`${(await client.compare(latest.sha, head)).totalCommits} commits behind`);
      const line = `${upToDate ? '🟢' : '🟡'} ${name} ${s.sha(short(latest.sha))}  ${s.dim(formatTime(latest.createdAt, ctx.timeZone))}  ${latest.creator}  ${behind}`;
      return { env, lines: [line, ...smokeFailed], upToDate };
    }),
  );
  rows.forEach((row) => row.lines.forEach((line) => ctx.print(line)));
  const behind = rows.filter((row) => !row.upToDate).map((row) => row.env);
  if (behind.length > 0) await warnIfBlocked(ctx, behind);
  const frozen = await freezeOf(ctx);
  if (frozen) describeFreeze(ctx, frozen).forEach((line) => ctx.print(line));
  return 0;
}

// `ship status` with no product: every product, fetched together, printed in list order.
export async function statusAll(
  products: Readonly<Record<string, string>>,
  load: (repo: string, print: (line: string) => void) => Promise<Context>,
  print: (line: string) => void,
  style: Style,
): Promise<number> {
  const sections = await Promise.all(
    Object.entries(products).map(async ([name, repo]) => {
      const lines: string[] = [];
      try {
        await status(await load(repo, (line) => lines.push(line)));
        return lines;
      } catch (error) {
        // One line per product that can't be read, never a half-printed section above it, plus the
        // same access or rate-limit hint a single-product command gives.
        const line = `⚠️  ${style.bold(name)} ${style.dim(`(${repo})`)}: ${error instanceof Error ? error.message : String(error)}`;
        if (error instanceof GitHubApiError && error.rateLimited) return [line, `   ⏳ ${RATE_LIMIT_HINT}`];
        return isAccessError(error) ? [line, `   🔑 ${accessHint(repo, undefined)}`] : [line];
      }
    }),
  );
  sections.forEach((lines, index) => {
    if (index > 0) print('');
    lines.forEach((line) => print(line));
  });
  return 0;
}

function printCommits(ctx: Context, commits: { sha: string; message: string; author: string }[], total: number, max: number) {
  const newest = [...commits].reverse().slice(0, max);
  const s = ctx.style;
  newest.forEach((c) => ctx.print(`   ${s.sha(short(c.sha))} ${c.message} ${s.dim(`· ${c.author}`)}`));
  if (total > newest.length) ctx.print(s.dim(`   …and ${total - newest.length} more`));
}

// The migrations a deploy adds, when ship.yaml says where they live; nothing when there are none.
function printMigrations(ctx: Context, comparison: Comparison) {
  const directories = ctx.manifest.migrations;
  if (!directories) return;
  const s = ctx.style;
  const { added, changed, truncated } = pendingMigrations(comparison.files ?? [], directories);
  if (added.length > 0) {
    ctx.print(`🗄️  ${s.warn(`${added.length} ${added.length === 1 ? 'migration' : 'migrations'} going out:`)}`);
    added.forEach((file) => ctx.print(`   ${file}`));
  }
  changed.forEach((file) => ctx.print(`⚠️  ${s.warn(`${file} was changed or removed, but shipped migrations shouldn't change`)}`));
  if (truncated) ctx.print(s.dim(`   …and more, see the compare: ${comparison.url}`));
}

export async function diff(ctx: Context, environment: string | undefined): Promise<number> {
  const s = ctx.style;
  const env = pickEnvironment(ctx.manifest, environment);
  const live = await ctx.client.lastSuccessfulDeployment(env);
  if (!live) {
    ctx.print(`⚪ ${s.env(env)} has never been deployed. ${ctx.defaultBranch} is at ${s.sha(short(ctx.head))}.`);
    await warnIfBlocked(ctx, [env]);
    await warnIfFrozen(ctx, env);
    return 0;
  }
  if (live === ctx.head) {
    ctx.print(`🟢 ${s.env(env)} is ${s.ok('up to date')} at ${s.sha(short(live))}.`);
    // A freeze still blocks a redeploy; the checks and prerequisites don't matter for a commit that is already live.
    await warnIfFrozen(ctx, env);
    return 0;
  }
  const comparison = await ctx.client.compare(live, ctx.head);
  ctx.print(`📦 ${s.env(env)}: ${s.sha(short(live))} → ${s.sha(short(ctx.head))} · ${s.warn(`${comparison.totalCommits} commits waiting`)}`);
  printCommits(ctx, comparison.commits, comparison.totalCommits, 50);
  printMigrations(ctx, comparison);
  ctx.print(`🔗 ${s.link(comparison.url)}`);
  await warnIfBlocked(ctx, [env]);
  await warnIfFrozen(ctx, env);
  return 0;
}

export async function log(ctx: Context, environment: string | undefined, limit: number): Promise<number> {
  const env = pickEnvironment(ctx.manifest, environment);
  const deployments = await ctx.client.deployments(env, limit);
  const s = ctx.style;
  if (deployments.length === 0) ctx.print(`⚪ No deployments to ${s.env(env)} yet.`);
  deployments.forEach((d) => {
    const [icon, paint] = look(d.state, s);
    ctx.print(`${icon} ${s.dim(formatTime(d.createdAt, ctx.timeZone))}  ${s.sha(short(d.sha))}  ${paint(d.state.padEnd(11))} ${d.creator}`);
  });
  return 0;
}

// Icon and colour for deployment states and job results.
const STATE_LOOK: Record<string, [string, 'ok' | 'bad' | 'dim' | 'warn']> = {
  success: ['✅', 'ok'],
  inactive: ['💤', 'dim'],
  failure: ['❌', 'bad'],
  error: ['❌', 'bad'],
  cancelled: ['🛑', 'bad'],
  skipped: ['⏭️', 'dim'],
};

// Anything not listed (queued, in_progress, pending…) is still running.
function look(state: string, s: Style): [string, (text: string) => string] {
  const [icon, tone] = STATE_LOOK[state] ?? ['⏳', 'warn'];
  return [icon, s[tone]];
}

// The step a running job is on, or undefined when it isn't running one.
export function currentStep(job: JobSummary): string | undefined {
  if (job.status !== 'in_progress') return undefined;
  return job.steps?.find((step) => step.status === 'in_progress')?.name;
}

const HEARTBEAT_MS = 60_000;

function jobLine(job: JobSummary, s: Style): string {
  const result = job.conclusion ?? job.status;
  const [icon, paint] = look(result, s);
  return `   ${icon} ${job.name}: ${paint(result)}`;
}

export async function deploy(ctx: Context, environment: string | undefined, options: DeployOptions): Promise<number> {
  const { client, manifest, head, style: s } = ctx;
  const env = pickEnvironment(manifest, environment);
  if (!manifest.dispatch) {
    throw new Error('ship.yaml has no dispatch.workflow, so ship cannot start a deploy. See the shipper README.');
  }
  if (!ctx.canWrite) throw new Error('Deploying needs a GitHub token. Run `gh auth login` or set GH_TOKEN.');

  const frozen = await freezeOf(ctx);
  if (frozen && freezeFailure(frozen, env)) {
    ctx.print(`❄️  ${s.bad(`${env} is frozen. Not deploying.`)}`);
    describeFreeze(ctx, frozen)
      .slice(1)
      .forEach((line) => ctx.print(line));
    ctx.print(`   ${s.dim(`Lift it with ship unfreeze ${manifest.product} ${env} when it is safe.`)}`);
    return 1;
  }

  const requires = manifest.environments[env]?.requires ?? [];
  ctx.print(`🔎 ${s.dim(`Checking ${short(head)} can ship to ${env}…`)}`);
  const [checkRuns, deployedTo, live] = await Promise.all([
    manifest.checks.length > 0 ? client.checkRuns(head) : Promise.resolve([]),
    client.deployedTo(head, requires),
    client.lastSuccessfulDeployment(env),
  ]);
  // A `requires` environment without the commit may be deploying it right now: then the deploy can queue behind it.
  const notYet = requires.filter((required) => !deployedTo.includes(required));
  const deployingTo = notYet.length > 0 ? await client.deployingTo(head, notYet) : [];
  // Unknown history never blocks a deploy: if GitHub can't compare, warn and carry on.
  const unknown = (what: string) => (error: unknown) => {
    ctx.print(`⚠️  ${s.warn(`Could not ${what}: ${error instanceof Error ? error.message : String(error)}`)}`);
    return undefined;
  };
  const relation = live && live !== head ? await client.relation(live, head).catch(unknown(`compare ${short(head)} with the live ${short(live)}`)) : undefined;
  const gate = evaluateGate(manifest, env, {
    sha: head,
    defaultBranch: ctx.defaultBranch,
    onDefaultBranch: true,
    checkRuns,
    deployedTo,
    deployingTo,
    live: live && relation ? { sha: live, relation } : undefined,
  });
  const queued = onlyWaiting(gate);
  if (queued) {
    ctx.print(`⏳ ${s.warn(`${short(head)} will be queued: the deploy waits for ${waitingFor(gate.waiting, gate.deploying)} to pass first.`)}`);
  } else if (!gate.ok) {
    ctx.print(`⛔ ${s.bad(`Can't ship ${short(head)} to ${env}:`)}`);
    gate.failures.forEach((failure) => ctx.print(`   • ${s.bad(failure)}`));
    return 1;
  }
  if (live === head && !options.redeploy) {
    ctx.print(`✅ ${s.sha(short(head))} is ${s.ok('already live')} on ${s.env(env)}. Nothing to ship ${s.dim('(use --redeploy to deploy it again)')}.`);
    return 0;
  }

  if (live && live !== head) {
    const comparison = await client.compare(live, head).catch(unknown('list the commits going out'));
    ctx.print(`📦 ${s.sha(short(live))} → ${s.sha(short(head))}${comparison ? ` · ${s.warn(`${comparison.totalCommits} commits`)}` : ''}`);
    if (comparison) {
      printCommits(ctx, comparison.commits, comparison.totalCommits, 10);
      printMigrations(ctx, comparison);
    }
  } else if (!live) {
    ctx.print(`🆕 First ship to ${s.env(env)}: ${s.sha(short(head))}`);
  }
  if (!(await approve(ctx, env, `🚀 Ship ${s.sha(short(head))} to ${s.env(env)}?`, options))) {
    ctx.print(`🙅 ${s.dim('Not shipped.')}`);
    return 1;
  }

  const { workflow, environmentInput } = manifest.dispatch;
  const since = options.now();
  ctx.print(`📨 ${s.dim(`Starting ${workflow} on ${ctx.defaultBranch}…`)}`);
  await client.dispatchWorkflow(workflow, ctx.defaultBranch, environmentInput ? { [environmentInput]: env } : {});
  if (queued) {
    ctx.print(`🕒 ${s.warn(`Queued. The workflow's gate waits for ${waitingFor(gate.waiting, gate.deploying)} (30 minutes by default), then deploys.`)}`);
  }
  return followRun(ctx, workflow, since, options, `🚀 ${s.ok(`Shipped ${short(head)} to ${env}.`)}`, queued ? gate.waiting : []);
}

// The line for a check the queued deploy was waiting on and is no longer: it passed, or it didn't.
function checkDone(name: string, runs: readonly CheckRun[], s: Style): string {
  return checkState(name, runs) === 'passed' ? `   ✅ ${s.ok(`check '${name}' passed`)}` : `   ❌ ${s.bad(`check '${name}' did not pass`)}`;
}

// Finds the run a dispatch started at `since`, prints each job as it changes, and ends with
// `shipped` or the failure. 0 when the run succeeded (or isn't being waited for). `queuedOn` names the
// checks a queued deploy waits on: until they finish, it also says which are still running.
async function followRun(
  ctx: Context,
  workflow: string,
  since: Date,
  options: FollowOptions,
  shipped: string,
  queuedOn: readonly string[] = [],
): Promise<number> {
  const { client, style: s } = ctx;
  // Ctrl-C only stops this terminal following; the run on GitHub goes on.
  const listen = (where: string) =>
    options.onInterrupt?.(() => ctx.print(`🛑 ${s.warn('Stopped following. The deploy keeps going on GitHub:')} ${s.link(where)}`));
  const findRun = async (attempt: number): Promise<Awaited<ReturnType<GitHubClient['findDispatchedRun']>>> => {
    const run = await client.findDispatchedRun(workflow, since);
    if (run || attempt >= (options.findRunAttempts ?? 20)) return run;
    await options.sleep(3000);
    return findRun(attempt + 1);
  };
  ctx.print(`⏳ ${s.dim('Waiting for GitHub to start the run…')}`);
  const stopFinding = listen(`https://github.com/${ctx.repo}/actions`);
  const started = await findRun(1).finally(() => stopFinding?.());
  if (!started) {
    ctx.print(`⏳ Started, but the run hasn't appeared yet. Check ${s.link(`https://github.com/${ctx.repo}/actions`)}`);
    return 0;
  }
  ctx.print(`▶️  Started: ${s.link(started.url)}`);
  if (!options.wait) return 0;

  // Elapsed time counts from the dispatch; the heartbeat's quiet clock starts at the "Started" line.
  const begun = since.getTime();
  const waitingLine = (checks: readonly string[], now: number) =>
    `   ⏳ ${s.warn(`Waiting for ${waitingFor(checks, [])}`)} ${s.dim(`· ${formatDuration(now - begun)}`)}`;
  // The checks still running, and a line for each one that finished since the last look.
  const checksNow = async (pending: readonly string[]): Promise<{ pending: readonly string[]; lines: string[] }> => {
    if (pending.length === 0) return { pending, lines: [] };
    const runs = await client.checkRuns(ctx.head).catch(() => undefined);
    if (!runs) return { pending, lines: [] };
    const still = pending.filter((name) => checkState(name, runs) === 'running');
    return { pending: still, lines: pending.filter((name) => !still.includes(name)).map((name) => checkDone(name, runs, s)) };
  };
  // seen: each job's last printed state and step. quietSince: when anything was last printed. pending: checks still running.
  const follow = async (seen: ReadonlyMap<string, string>, quietSince: number, pending: readonly string[]): Promise<number> => {
    await options.sleep(options.pollMs ?? 10_000);
    const [run, jobs, checks] = await Promise.all([client.run(started.id), client.jobs(started.id), checksNow(pending)]);
    const now = options.now().getTime();
    const checkLines = [...checks.lines, ...(checks.lines.length > 0 && checks.pending.length > 0 ? [waitingLine(checks.pending, now)] : [])];
    const jobLines = jobs.flatMap((job) => {
      const state = job.conclusion ?? job.status;
      const step = currentStep(job);
      const [prevState, prevStep] = (seen.get(job.name) ?? '').split('\u0000');
      if (prevState !== state) return [jobLine(job, s), ...(step ? [`      ↳ ${step}`] : [])];
      return step && step !== prevStep ? [`      ↳ ${job.name} › ${step}`] : [];
    });
    const lines = [...checkLines, ...jobLines];
    lines.forEach((line) => ctx.print(line));
    const running = [
      ...(checks.pending.length > 0 ? [`waiting for ${waitingFor(checks.pending, [])}`] : []),
      ...jobs.flatMap((job) => {
        const step = currentStep(job);
        return step ? [`${job.name} › ${step}`] : job.status === 'in_progress' ? [job.name] : [];
      }),
    ];
    const heartbeat = lines.length === 0 && run.status !== 'completed' && now - quietSince >= HEARTBEAT_MS;
    if (heartbeat) {
      ctx.print(`   ⏱️  ${s.dim(`Still running · ${formatDuration(now - begun)}${running.length > 0 ? ` · ${running.join(', ')}` : ''}`)}`);
    }
    const next = new Map(jobs.map((job) => [job.name, `${job.conclusion ?? job.status}\u0000${currentStep(job) ?? ''}`]));
    if (run.status !== 'completed') return follow(next, lines.length > 0 || heartbeat ? now : quietSince, checks.pending);
    const took = s.dim(`(${formatDuration(now - begun)})`);
    if (run.conclusion !== 'success') {
      jobs
        .filter((job) => job.conclusion === 'failure')
        .forEach((job) => {
          const step = job.steps?.find((candidate) => candidate.conclusion === 'failure');
          ctx.print(`   ❌ ${s.bad(step ? `${job.name} › ${step.name}` : job.name)}`);
        });
    }
    ctx.print(run.conclusion === 'success' ? `${shipped} ${took}` : `💥 ${s.bad(`Deploy ${run.conclusion ?? 'ended'}:`)} ${s.link(run.url)} ${took}`);
    return run.conclusion === 'success' ? 0 : 1;
  };
  if (queuedOn.length > 0) ctx.print(waitingLine(queuedOn, options.now().getTime()));
  const stopFollowing = listen(started.url);
  return follow(new Map(), options.now().getTime(), queuedOn).finally(() => stopFollowing?.());
}

const wasLive = (deployment: DeploymentSummary) => deployment.state === 'success' || deployment.state === 'inactive';

// The commit to roll back to: the one asked for (a SHA or a prefix of 7+ characters), or the newest
// one that was live before the live one. It must have been live on this environment.
function rollbackTarget(deployments: readonly DeploymentSummary[], live: string, env: string, to: string | undefined): string {
  const candidates = deployments
    .filter(wasLive)
    .map((d) => d.sha)
    .filter((sha) => sha !== live);
  if (!to) {
    const [newest] = candidates;
    if (newest) return newest;
    throw new Error(`No earlier deploy of ${env} to roll back to.`);
  }
  if (to.length < 7) throw new Error(`--to needs at least 7 characters of the SHA (got '${to}').`);
  if (live.startsWith(to)) throw new Error(`${short(live)} is already live on ${env}.`);
  const match = candidates.find((sha) => sha.startsWith(to));
  if (match) return match;
  throw new Error(`${to} was never live on ${env} in its recent deploys, so it can't be a rollback target. See ship log.`);
}

function missingRollbackWorkflow(workflow: string): string {
  return [
    `This repo has no .github/workflows/${workflow} to roll back with (GitHub says it doesn't exist). Add it:`,
    '',
    'name: Ship rollback',
    'on:',
    '  workflow_dispatch:',
    '    inputs:',
    '      environment: { description: Environment to roll back, required: true, type: string }',
    '      sha: { description: Commit to deploy, required: true, type: string }',
    'jobs:',
    '  rollback:',
    '    permissions: { contents: read, checks: read, deployments: write }',
    '    # Pin shipper to an exact commit SHA (Dependabot for GitHub Actions can bump it), and pass the same',
    '    # SHA as shipper-ref. Replace the SHA and the version comment with the shipper release you use.',
    '    uses: ideaSquared/shipper/.github/workflows/deploy.yml@<full-commit-sha> # v1.x',
    '    with:',
    '      environment: ${{ inputs.environment }}',
    '      sha: ${{ inputs.sha }}',
    '      rollback: true',
    '      shipper-ref: <full-commit-sha> # v1.x',
    '    secrets: inherit',
  ].join('\n');
}

export async function rollback(ctx: Context, environment: string | undefined, options: RollbackOptions): Promise<number> {
  const { client, manifest, style: s } = ctx;
  const env = pickEnvironment(manifest, environment);
  if (!ctx.canWrite) throw new Error('Rolling back needs a GitHub token. Run `gh auth login` or set GH_TOKEN.');

  const [live, deployments] = await Promise.all([client.lastSuccessfulDeployment(env), client.deployments(env, 50)]);
  if (!live) throw new Error(`${env} has never been deployed, so there is nothing to roll back.`);
  // A release whose smoke checks failed is recorded as `error` but is still what's running (nothing rolled it
  // back), so roll back from it: the last `success` release is then a valid target, not "already live".
  const running = deployments[0]?.state === 'error' ? deployments[0].sha : live;
  const target = rollbackTarget(deployments, running, env, options.to);

  // An incident often needs a rollback, so a freeze only gets mentioned, and an unreadable one never stops it.
  const frozen = await freezeOf(ctx).catch((error: unknown) => {
    ctx.print(`⚠️  ${s.warn(`Could not check for a freeze: ${error instanceof Error ? error.message : String(error)}`)}`);
    return undefined;
  });
  if (frozen && freezeFailure(frozen, env)) describeFreeze(ctx, frozen).forEach((line) => ctx.print(line));

  const comparison = await client.compare(target, running).catch((error: unknown) => {
    ctx.print(`⚠️  ${s.warn(`Could not list the commits being taken out: ${error instanceof Error ? error.message : String(error)}`)}`);
    return undefined;
  });
  ctx.print(`⏪ live ${s.sha(short(running))} → ${s.sha(short(target))}${comparison ? ` · ${s.warn(`${comparison.totalCommits} commits taken out`)}` : ''}`);
  if (comparison) printCommits(ctx, comparison.commits, comparison.totalCommits, 10);
  if (!(await approve(ctx, env, `⏪ Roll ${s.env(env)} back to ${s.sha(short(target))}?`, options))) {
    ctx.print(`🙅 ${s.dim('Not rolled back.')}`);
    return 1;
  }

  const workflow = manifest.dispatch?.rollbackWorkflow ?? DEFAULT_ROLLBACK_WORKFLOW;
  const since = options.now();
  await client.dispatchWorkflow(workflow, ctx.defaultBranch, { environment: env, sha: target }).catch((error: unknown) => {
    if (error instanceof GitHubApiError && error.status === 404) throw new Error(missingRollbackWorkflow(workflow));
    throw error;
  });
  return followRun(ctx, workflow, since, options, `⏪ ${s.ok(`Rolled ${env} back to ${short(target)}.`)}`);
}
