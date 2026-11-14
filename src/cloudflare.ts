import { join } from 'node:path';
import type { CloudflareWorker, HealthCheck, Manifest } from './manifest.ts';
import { environmentOf, healthFor } from './manifest.ts';

export type RunResult = { code: number; output: string };
// `env` is added to the process environment of the command.
export type Run = (command: string, args: readonly string[], cwd: string, env?: Readonly<Record<string, string>>) => Promise<RunResult>;
export type Sleep = (ms: number) => Promise<void>;

export type ComponentStatus = 'deployed' | 'failed' | 'rolled-back' | 'skipped';
export type ComponentResult = { name: string; status: ComponentStatus; url?: string; detail?: string };

export type DeployOptions = {
  manifest: Manifest;
  environment: string;
  sha: string;
  actor: string;
  repoRoot: string;
  run: Run;
  fetch: typeof fetch;
  sleep: Sleep;
  healthAttempts?: number;
  healthIntervalMs?: number;
  healthTimeoutMs?: number;
};

// The URLs wrangler prints for the Worker it just deployed. Wrangler puts each one on a line of its own
// under "Deployed <name> triggers"; URLs elsewhere (a var's value, a docs link) share their line with
// other text, so only bare URL lines count.
export function parseDeployedUrls(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^https:\/\/\S+$/.test(line));
}

export function resolveHealthUrl(health: string, deployedUrls: readonly string[]): string {
  if (/^https?:\/\//.test(health)) return health;
  const base = deployedUrls[0];
  if (!base) throw new Error(`health is a path (${health}) but wrangler printed no URL to put it on; use a full URL`);
  return new URL(health, base).toString();
}

const EXCERPT_LENGTH = 120;

function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return JSON.stringify(flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH)}…` : flat);
}

type Attempt = { failure?: string; mismatch?: string };

// `match` also requires the body to contain `expect`; `label` (the environment) names the check in that message.
export async function pollHealth(
  url: string,
  fetchImpl: typeof fetch,
  sleep: Sleep,
  attempts: number,
  intervalMs: number,
  requestTimeoutMs = 10_000,
  match?: { expect: string; label: string },
): Promise<{ ok: boolean; detail: string }> {
  const check = async (): Promise<Attempt> => {
    // The timeout stops a Worker that accepts the connection but never answers from holding the deploy open.
    const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(requestTimeoutMs) });
    if (!response.ok) return { failure: `HTTP ${response.status}` };
    if (!match) return {};
    const body = await response.text();
    if (body.includes(match.expect)) return {};
    return {
      mismatch: `health check for ${match.label} returned ${response.status} but body did not contain ${JSON.stringify(match.expect)}; body was ${excerpt(body)}`,
    };
  };
  const attempt = async (n: number): Promise<{ ok: boolean; detail: string }> => {
    const result = await check().catch((error: unknown): Attempt => ({ failure: error instanceof Error ? error.message : String(error) }));
    if (!result.failure && !result.mismatch) return { ok: true, detail: `${url} answered` };
    if (n >= attempts) {
      return result.mismatch
        ? { ok: false, detail: `${result.mismatch} (${url}, ${attempts} attempts)` }
        : { ok: false, detail: `${url} failed ${attempts} times, last: ${result.failure}` };
    }
    await sleep(intervalMs);
    return attempt(n + 1);
  };
  return attempt(1);
}

// Any failure here, including not knowing which URL to check, rolls the new version back.
async function checkHealth(
  health: HealthCheck,
  environment: string,
  deployOutput: string,
  options: DeployOptions,
): Promise<{ ok: boolean; detail: string }> {
  const resolved = ((): { url: string } | { error: string } => {
    try {
      return { url: resolveHealthUrl(health.url, parseDeployedUrls(deployOutput)) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  })();
  if ('error' in resolved) return { ok: false, detail: resolved.error };
  return pollHealth(
    resolved.url,
    options.fetch,
    options.sleep,
    options.healthAttempts ?? 10,
    options.healthIntervalMs ?? 6000,
    options.healthTimeoutMs,
    health.expect ? { expect: health.expect, label: environment } : undefined,
  );
}

async function deployOne(name: string, component: CloudflareWorker, options: DeployOptions): Promise<ComponentResult> {
  const { run, repoRoot, sha, actor } = options;
  const wranglerEnv = environmentOf(options.manifest, options.environment).wranglerEnv;
  const envArgs = wranglerEnv ? ['--env', wranglerEnv] : [];
  const cwd = join(repoRoot, component.path);
  const short = sha.slice(0, 7);
  const wrangler = (args: readonly string[]) => run('pnpm', ['exec', 'wrangler', ...args, ...envArgs], cwd);

  if (component.build) {
    const buildEnv = { SHIP_ENVIRONMENT: options.environment, SHIP_WRANGLER_ENV: wranglerEnv ?? '' };
    const build = await run('bash', ['-c', component.build], repoRoot, buildEnv);
    if (build.code !== 0) return { name, status: 'failed', detail: 'build failed' };
  }

  if (component.migrations) {
    const migrate = await wrangler(['d1', 'migrations', 'apply', component.migrations.d1, '--remote']);
    if (migrate.code !== 0) return { name, status: 'failed', detail: 'D1 migrations failed; nothing was deployed' };
  }

  const deploy = await wrangler(['deploy', '--message', `ship ${short} by ${actor}`]);
  if (deploy.code !== 0) return { name, status: 'failed', detail: 'wrangler deploy failed' };
  const url = parseDeployedUrls(deploy.output)[0];

  if (!component.health) return { name, status: 'deployed', url };
  const healthCheck = healthFor(component, options.environment);
  if (!healthCheck) return { name, status: 'deployed', url, detail: `no health check for ${options.environment}` };

  const health = await checkHealth(healthCheck, options.environment, deploy.output, options);
  if (health.ok) return { name, status: 'deployed', url, detail: `health check passed: ${health.detail}` };

  const schemaNote = component.migrations ? ' D1 migrations are forward-only and were not undone.' : '';
  const rollback = await wrangler(['rollback', '--yes', '--message', `ship: health check failed for ${short}`]);
  return rollback.code === 0
    ? { name, status: 'rolled-back', url, detail: `${health.detail}. Rolled back to the previous version.${schemaNote}` }
    : { name, status: 'failed', url, detail: `${health.detail}. Rollback also failed: roll back by hand.${schemaNote}` };
}

// Deploys every component in manifest order and stops at the first one that does not deploy.
export async function deployComponents(options: DeployOptions): Promise<ComponentResult[]> {
  return Object.entries(options.manifest.components).reduce<Promise<ComponentResult[]>>(async (previous, [name, component]) => {
    const results = await previous;
    if (results.some((result) => result.status !== 'deployed')) return [...results, { name, status: 'skipped' }];
    if (component.type === 'external') {
      return [...results, { name, status: 'failed', detail: `deployed by ${component.workflow}, not by shipper's deploy job: call gate.yml and report.yml around it` }];
    }
    return [...results, await deployOne(name, component, options)];
  }, Promise.resolve([]));
}

export function renderSummary(environment: string, sha: string, results: readonly ComponentResult[]): string {
  const rows = results.map(
    (result) => `| ${result.name} | ${result.status} | ${result.url ?? ''} | ${result.detail ?? ''} |`,
  );
  return [
    `### Ship ${sha.slice(0, 7)} to ${environment}`,
    '',
    '| Component | Result | URL | Detail |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}
