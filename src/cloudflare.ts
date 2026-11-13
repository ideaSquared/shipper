import { join } from 'node:path';
import type { Component, Manifest } from './manifest.ts';
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

export async function pollHealth(
  url: string,
  fetchImpl: typeof fetch,
  sleep: Sleep,
  attempts: number,
  intervalMs: number,
  requestTimeoutMs = 10_000,
): Promise<{ ok: boolean; detail: string }> {
  const attempt = async (n: number): Promise<{ ok: boolean; detail: string }> => {
    // The timeout stops a Worker that accepts the connection but never answers from holding the deploy open.
    const request = fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(requestTimeoutMs) });
    const detail = await request.then(
      (response) => (response.ok ? undefined : `HTTP ${response.status}`),
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    if (detail === undefined) return { ok: true, detail: `${url} answered` };
    if (n >= attempts) return { ok: false, detail: `${url} failed ${attempts} times, last: ${detail}` };
    await sleep(intervalMs);
    return attempt(n + 1);
  };
  return attempt(1);
}

// Any failure here, including not knowing which URL to check, rolls the new version back.
async function checkHealth(
  health: string,
  deployOutput: string,
  options: DeployOptions,
): Promise<{ ok: boolean; detail: string }> {
  const resolved = ((): { url: string } | { error: string } => {
    try {
      return { url: resolveHealthUrl(health, parseDeployedUrls(deployOutput)) };
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
  );
}

async function deployOne(name: string, component: Component, options: DeployOptions): Promise<ComponentResult> {
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
  const healthPath = healthFor(component, options.environment);
  if (!healthPath) return { name, status: 'deployed', url, detail: `no health check for ${options.environment}` };

  const health = await checkHealth(healthPath, deploy.output, options);
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
