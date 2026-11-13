// Entry point the reusable workflow runs: `node src/main.ts <gate|deploy> <environment>`.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { deployComponents, renderSummary, type Run } from './cloudflare.ts';
import { evaluateGate, staleFailure, type GateFacts } from './gate.ts';
import { createGitHubClient, type GitHubClient } from './github.ts';
import { environmentOf, parseManifest, type Manifest } from './manifest.ts';
import { buildReport, outcomeOf, sendReport, type Comparison, type ReportInput } from './notify.ts';

const EnvSchema = z.object({
  SHIP_REPO_ROOT: z.string().min(1),
  GITHUB_REPOSITORY: z.string().min(1),
  GITHUB_SHA: z.string().min(1),
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
    sha: env.GITHUB_SHA,
    runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
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

async function gate(environment: string): Promise<number> {
  const env = EnvSchema.extend({ DEFAULT_BRANCH: z.string().min(1) }).parse(process.env);
  const manifest = loadManifest(env.SHIP_REPO_ROOT);
  const required = environmentOf(manifest, environment).requires;
  const github = createGitHubClient(env.GITHUB_REPOSITORY, env.GITHUB_TOKEN);
  const [onDefaultBranch, checkRuns, deployedTo, liveSha] = await Promise.all([
    github.isOnBranch(env.GITHUB_SHA, env.DEFAULT_BRANCH),
    manifest.checks.length > 0 ? github.checkRuns(env.GITHUB_SHA) : Promise.resolve([]),
    github.deployedTo(env.GITHUB_SHA, required),
    github.lastSuccessfulDeployment(environment).catch(() => undefined),
  ]);
  const result = evaluateGate(manifest, environment, {
    sha: env.GITHUB_SHA,
    defaultBranch: env.DEFAULT_BRANCH,
    onDefaultBranch,
    checkRuns,
    deployedTo,
    live: await liveFacts(github, environment, env.GITHUB_SHA, liveSha),
  });
  if (result.ok) {
    console.log(`Gate passed: ${env.GITHUB_SHA.slice(0, 7)} can deploy to ${environment}.`);
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
  // this run waited, or this may be a re-run of an old run.
  const stale = staleFailure(env.GITHUB_SHA, environment, await liveFacts(github, environment, env.GITHUB_SHA, previousSha));
  if (stale) {
    annotate('Ship', `${stale}. Not deploying an older commit over a newer one.`);
    summarise(env.GITHUB_STEP_SUMMARY, `### Ship blocked for ${environment}\n\n- ${stale}\n`);
    await notify(env, manifest, { environment, outcome: 'blocked', failures: [stale] });
    return 1;
  }

  const results = await deployComponents({
    manifest,
    environment,
    sha: env.GITHUB_SHA,
    actor: env.GITHUB_ACTOR,
    repoRoot: env.SHIP_REPO_ROOT,
    run,
    fetch,
    sleep: (ms) => sleep(ms),
  });
  results.forEach((result) =>
    console.log([`${result.name}: ${result.status}`, result.url, result.detail].filter(Boolean).join(' · ')),
  );
  summarise(env.GITHUB_STEP_SUMMARY, renderSummary(environment, env.GITHUB_SHA, results));
  results
    .filter((result) => result.status === 'failed' || result.status === 'rolled-back')
    .forEach((result) => annotate(`Ship ${result.name}`, result.detail ?? result.status));

  await notify(env, manifest, {
    environment,
    outcome: outcomeOf(results),
    previousSha,
    comparison: await changesSince(github, previousSha, env.GITHUB_SHA),
    components: results,
  });
  return results.every((result) => result.status === 'deployed') ? 0 : 1;
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
