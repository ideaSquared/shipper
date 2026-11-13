// Entry point the reusable workflow runs: `node src/main.ts <gate|deploy> <environment>`.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { deployComponents, renderSummary, type Run } from './cloudflare.ts';
import { evaluateGate, liveFailure, type GateFacts } from './gate.ts';
import { createGitHubClient, GitHubApiError, type GitHubClient, type NewDeploymentStatus } from './github.ts';
import { environmentOf, parseManifest, type Manifest } from './manifest.ts';
import { buildReport, outcomeOf, sendReport, type Comparison, type ReportInput } from './notify.ts';

const EnvSchema = z.object({
  SHIP_REPO_ROOT: z.string().min(1),
  GITHUB_REPOSITORY: z.string().min(1),
  // The commit to deploy: the workflow's `sha` input, or the run's own commit.
  SHIP_SHA: z.string().min(1),
  // `rollback: true`: put back a commit that was live before, even though it is older than what is live.
  SHIP_ROLLBACK: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  GITHUB_ACTOR: z.string().default('unknown'),
  GITHUB_STEP_SUMMARY: z.string().optional(),
  GITHUB_SERVER_URL: z.string().default('https://github.com'),
  GITHUB_RUN_ID: z.string().default(''),
  GITHUB_TOKEN: z.string().min(1),
  SHIP_NOTIFY_URL: z.string().optional(),
  SHIP_NOTIFY_SECRET: z.string().optional(),
});
type ShipEnv = z.infer<typeof EnvSchema>;

// Streams the command's output to the job log and also returns it.
const run: Run = (command, args, cwd, extraEnv = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: string[] = [];
    const collect = (stream: NodeJS.WritableStream) => (chunk: Buffer) => {
      chunks.push(chunk.toString());
      stream.write(chunk);
    };
    child.stdout.on('data', collect(process.stdout));
    child.stderr.on('data', collect(process.stderr));
    child.on('error', (error) => resolve({ code: 1, output: error.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, output: chunks.join('') }));
  });

// GitHub workflow commands end at a newline, so encode them.
function annotate(title: string, message: string, level: 'error' | 'warning' | 'notice' = 'error'): void {
  const encode = (text: string) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::${level} title=${encode(title)}::${encode(message)}`);
}

const runUrlOf = (env: ShipEnv) => `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;

// Sends the deploy message to Discord through the ideaSquared bot. Only ever warns.
async function notify(env: ShipEnv, manifest: Manifest, input: Omit<ReportInput, 'project' | 'product' | 'repository' | 'actor' | 'at' | 'sha' | 'runUrl'>): Promise<void> {
  if (!manifest.discord) {
    annotate('Ship', 'No Discord message: ship.yaml has no discord project.', 'notice');
    return;
  }
  if (!env.SHIP_NOTIFY_URL || !env.SHIP_NOTIFY_SECRET) {
    annotate('Ship', 'No Discord message: SHIP_NOTIFY_SECRET is not set (pass secrets: inherit).', 'warning');
    return;
  }
  const report = buildReport({
    ...input,
    project: manifest.discord,
    product: manifest.product,
    repository: env.GITHUB_REPOSITORY,
    actor: env.GITHUB_ACTOR,
    at: new Date(),
    sha: env.SHIP_SHA,
    runUrl: runUrlOf(env),
  });
  const sent = await sendReport(env.SHIP_NOTIFY_URL, env.SHIP_NOTIFY_SECRET, report);
  if (sent.ok) console.log(sent.detail);
  else annotate('Ship', `Discord message not sent: ${sent.detail}`, 'warning');
}

// What changed since the last successful deploy. Missing history only costs the commit list.
async function changesSince(github: GitHubClient, previousSha: string | undefined, sha: string): Promise<Comparison | undefined> {
  if (!previousSha) return undefined;
  return github.compare(previousSha, sha).catch((error: unknown) => {
    annotate('Ship', `Could not list commits since ${previousSha.slice(0, 7)}: ${String(error)}`, 'warning');
    return undefined;
  });
}

function loadManifest(repoRoot: string): Manifest {
  const path = join(repoRoot, 'ship.yaml');
  if (!existsSync(path)) throw new Error('No ship.yaml at the repository root. See the shipper README for the format.');
  return parseManifest(readFileSync(path, 'utf8'));
}

function summarise(path: string | undefined, markdown: string): void {
  if (path) appendFileSync(path, markdown);
}

// What is live in the environment and how `sha` relates to it. Unknown history never blocks a deploy.
async function liveFacts(github: GitHubClient, environment: string, sha: string, live?: string): Promise<GateFacts['live']> {
  if (!live) return undefined;
  return github.relation(live, sha).then(
    (relation) => ({ sha: live, relation }),
    (error: unknown) => {
      annotate('Ship', `Could not compare ${sha.slice(0, 7)} with the live ${live.slice(0, 7)}: ${String(error)}`, 'warning');
      return undefined;
    },
  );
}

// Shipper records the Deployment itself (the deploy job sets `deployment: false`), so it names the
// commit really deployed rather than the run's own commit.
async function createDeployment(github: GitHubClient, env: ShipEnv, environment: string): Promise<{ id: number } | { error: string }> {
  return github
    .createDeployment({ sha: env.SHIP_SHA, environment, actor: env.GITHUB_ACTOR, production: environment === 'production' })
    .then((id) => ({ id }))
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof GitHubApiError && (error.status === 403 || error.status === 404)) {
        return { error: `Could not create a GitHub Deployment (${reason}). The job that calls shipper must grant \`permissions: deployments: write\`.` };
      }
      return { error: `Could not create a GitHub Deployment: ${reason}` };
    });
}

// Posts a Deployment status; returns false (after saying why) if GitHub did not take it.
async function recordStatus(github: GitHubClient, id: number, status: NewDeploymentStatus): Promise<boolean> {
  return github.setDeploymentStatus(id, status).then(
    () => true,
    (error: unknown) => {
      annotate('Ship', `Could not mark the GitHub Deployment ${status.state}: ${String(error)}`, status.state === 'in_progress' ? 'warning' : 'error');
      return false;
    },
  );
}

async function gate(environment: string): Promise<number> {
  const env = EnvSchema.extend({ DEFAULT_BRANCH: z.string().min(1) }).parse(process.env);
  const manifest = loadManifest(env.SHIP_REPO_ROOT);
  const required = environmentOf(manifest, environment).requires;
  const github = createGitHubClient(env.GITHUB_REPOSITORY, env.GITHUB_TOKEN);
  // A rollback target must have been live here before; a normal deploy must not be older than live.
  const [onDefaultBranch, checkRuns, deployedTo, liveSha] = await Promise.all([
    github.isOnBranch(env.SHIP_SHA, env.DEFAULT_BRANCH),
    manifest.checks.length > 0 ? github.checkRuns(env.SHIP_SHA) : Promise.resolve([]),
    github.deployedTo(env.SHIP_SHA, env.SHIP_ROLLBACK ? [...required, environment] : required),
    env.SHIP_ROLLBACK ? Promise.resolve(undefined) : github.lastSuccessfulDeployment(environment).catch(() => undefined),
  ]);
  const result = evaluateGate(manifest, environment, {
    sha: env.SHIP_SHA,
    defaultBranch: env.DEFAULT_BRANCH,
    onDefaultBranch,
    checkRuns,
    deployedTo,
    live: await liveFacts(github, environment, env.SHIP_SHA, liveSha),
    rollback: env.SHIP_ROLLBACK,
  });
  if (result.ok) {
    console.log(`Gate passed: ${env.SHIP_SHA.slice(0, 7)} can deploy to ${environment}.`);
    return 0;
  }
  result.failures.forEach((failure) => annotate('Ship gate', failure));
  summarise(
    env.GITHUB_STEP_SUMMARY,
    [`### Ship blocked for ${environment}`, '', ...result.failures.map((f) => `- ${f}`), ''].join('\n'),
  );
  await notify(env, manifest, { environment, outcome: 'blocked', failures: result.failures });
  return 1;
}

async function deploy(environment: string): Promise<number> {
  const env = EnvSchema.parse(process.env);
  const manifest = loadManifest(env.SHIP_REPO_ROOT);
  const github = createGitHubClient(env.GITHUB_REPOSITORY, env.GITHUB_TOKEN);
  const missing = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    const message = `${missing.join(' and ')} not set. Add them to the '${environment}' GitHub Environment or the repo secrets, and pass secrets: inherit.`;
    annotate('Ship', message);
    await notify(env, manifest, { environment, outcome: 'failed', failures: [message] });
    return 1;
  }

  // Read before deploying: once this deploy succeeds, it becomes the newest successful one.
  const previousSha = await github.lastSuccessfulDeployment(environment).catch((error: unknown) => {
    annotate('Ship', `Could not read the last deploy to ${environment}: ${String(error)}`, 'warning');
    return undefined;
  });

  // Checked again here, inside the one-deploy-at-a-time job: a newer commit may have shipped while
  // this run waited, or this may be a re-run of an old run. A rollback instead re-checks its target was live.
  const blocked = liveFailure(
    {
      sha: env.SHIP_SHA,
      rollback: env.SHIP_ROLLBACK,
      live: env.SHIP_ROLLBACK ? undefined : await liveFacts(github, environment, env.SHIP_SHA, previousSha),
      deployedTo: env.SHIP_ROLLBACK ? await github.deployedTo(env.SHIP_SHA, [environment]) : [],
    },
    environment,
  );
  if (blocked) {
    annotate('Ship', env.SHIP_ROLLBACK ? `${blocked}.` : `${blocked}. Not deploying an older commit over a newer one.`);
    summarise(env.GITHUB_STEP_SUMMARY, `### Ship blocked for ${environment}\n\n- ${blocked}\n`);
    await notify(env, manifest, { environment, outcome: 'blocked', failures: [blocked] });
    return 1;
  }

  const created = await createDeployment(github, env, environment);
  if ('error' in created) {
    annotate('Ship', created.error);
    await notify(env, manifest, { environment, outcome: 'failed', failures: [created.error] });
    return 1;
  }
  const deployment = created.id;
  const logUrl = runUrlOf(env);
  await recordStatus(github, deployment, { state: 'in_progress', logUrl });

  const results = await deployComponents({
    manifest,
    environment,
    sha: env.SHIP_SHA,
    actor: env.GITHUB_ACTOR,
    repoRoot: env.SHIP_REPO_ROOT,
    run,
    fetch,
    sleep: (ms) => sleep(ms),
  }).catch(async (error: unknown) => {
    await recordStatus(github, deployment, { state: 'failure', logUrl });
    throw error;
  });
  results.forEach((result) =>
    console.log([`${result.name}: ${result.status}`, result.url, result.detail].filter(Boolean).join(' · ')),
  );
  summarise(env.GITHUB_STEP_SUMMARY, renderSummary(environment, env.SHIP_SHA, results));
  results
    .filter((result) => result.status === 'failed' || result.status === 'rolled-back')
    .forEach((result) => annotate(`Ship ${result.name}`, result.detail ?? result.status));

  const shipped = results.every((result) => result.status === 'deployed');
  // GitHub's record is what the gate reads next time (requires, stale checks), so failing to write it fails the job.
  const recorded = await recordStatus(
    github,
    deployment,
    shipped
      ? { state: 'success', logUrl, environmentUrl: results.find((result) => result.url)?.url }
      : { state: 'failure', logUrl },
  );

  await notify(env, manifest, {
    environment,
    outcome: outcomeOf(results),
    previousSha,
    comparison: await changesSince(github, previousSha, env.SHIP_SHA),
    components: results,
  });
  return shipped && recorded ? 0 : 1;
}

const COMMANDS = { gate, deploy } as const;
const [command, environment] = process.argv.slice(2);

if (!command || !(command in COMMANDS) || !environment) {
  console.error('Usage: node src/main.ts <gate|deploy> <environment>');
  process.exit(2);
}

// The guard above has checked that `command` is a key of COMMANDS.
COMMANDS[command as keyof typeof COMMANDS](environment).then(
  (code) => process.exit(code),
  (error: unknown) => {
    annotate('Ship', error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
