// Entry point the reusable workflow runs: `node src/main.ts <gate|deploy> <environment>`.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { deployComponents, renderSummary, type Run } from './cloudflare.ts';
import { evaluateGate } from './gate.ts';
import { createGitHubClient } from './github.ts';
import { environmentOf, parseManifest, type Manifest } from './manifest.ts';

const EnvSchema = z.object({
  SHIP_REPO_ROOT: z.string().min(1),
  GITHUB_REPOSITORY: z.string().min(1),
  GITHUB_SHA: z.string().min(1),
  GITHUB_ACTOR: z.string().default('unknown'),
  GITHUB_STEP_SUMMARY: z.string().optional(),
});

// Streams the command's output to the job log and also returns it.
const run: Run = (command, args, cwd) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
function annotate(title: string, message: string): void {
  const encode = (text: string) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::error title=${encode(title)}::${encode(message)}`);
}

function loadManifest(repoRoot: string): Manifest {
  const path = join(repoRoot, 'ship.yaml');
  if (!existsSync(path)) throw new Error('No ship.yaml at the repository root. See the shipper README for the format.');
  return parseManifest(readFileSync(path, 'utf8'));
}

function summarise(path: string | undefined, markdown: string): void {
  if (path) appendFileSync(path, markdown);
}

async function gate(environment: string): Promise<number> {
  const env = EnvSchema.extend({ GITHUB_TOKEN: z.string().min(1), DEFAULT_BRANCH: z.string().min(1) }).parse(
    process.env,
  );
  const manifest = loadManifest(env.SHIP_REPO_ROOT);
  const required = environmentOf(manifest, environment).requires;
  const github = createGitHubClient(env.GITHUB_REPOSITORY, env.GITHUB_TOKEN);
  const [onDefaultBranch, checkRuns, deployedTo] = await Promise.all([
    github.isOnBranch(env.GITHUB_SHA, env.DEFAULT_BRANCH),
    manifest.checks.length > 0 ? github.checkRuns(env.GITHUB_SHA) : Promise.resolve([]),
    github.deployedTo(env.GITHUB_SHA, required),
  ]);
  const result = evaluateGate(manifest, environment, {
    sha: env.GITHUB_SHA,
    defaultBranch: env.DEFAULT_BRANCH,
    onDefaultBranch,
    checkRuns,
    deployedTo,
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
  return 1;
}

async function deploy(environment: string): Promise<number> {
  const env = EnvSchema.parse(process.env);
  const missing = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    annotate(
      'Ship',
      `${missing.join(' and ')} not set. Add them to the '${environment}' GitHub Environment or the repo secrets, and pass secrets: inherit.`,
    );
    return 1;
  }
  const manifest = loadManifest(env.SHIP_REPO_ROOT);
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
  summarise(env.GITHUB_STEP_SUMMARY, renderSummary(environment, env.GITHUB_SHA, results));
  results
    .filter((result) => result.status === 'failed' || result.status === 'rolled-back')
    .forEach((result) => annotate(`Ship ${result.name}`, result.detail ?? result.status));
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
