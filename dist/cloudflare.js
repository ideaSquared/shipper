import { join } from 'node:path';
import { environmentOf } from "./manifest.js";
// The URLs wrangler prints for the Worker it just deployed. Wrangler puts each one on a line of its own
// under "Deployed <name> triggers"; URLs elsewhere (a var's value, a docs link) share their line with
// other text, so only bare URL lines count.
export function parseDeployedUrls(output) {
    return output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^https:\/\/\S+$/.test(line));
}
export function resolveHealthUrl(health, deployedUrls) {
    if (/^https?:\/\//.test(health))
        return health;
    const base = deployedUrls[0];
    if (!base)
        throw new Error(`health is a path (${health}) but wrangler printed no URL to put it on; use a full URL`);
    return new URL(health, base).toString();
}
export async function pollHealth(url, fetchImpl, sleep, attempts, intervalMs, requestTimeoutMs = 10_000) {
    const attempt = async (n) => {
        // The timeout stops a Worker that accepts the connection but never answers from holding the deploy open.
        const request = fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(requestTimeoutMs) });
        const detail = await request.then((response) => (response.ok ? undefined : `HTTP ${response.status}`), (error) => (error instanceof Error ? error.message : String(error)));
        if (detail === undefined)
            return { ok: true, detail: `${url} answered` };
        if (n >= attempts)
            return { ok: false, detail: `${url} failed ${attempts} times, last: ${detail}` };
        await sleep(intervalMs);
        return attempt(n + 1);
    };
    return attempt(1);
}
// Any failure here, including not knowing which URL to check, rolls the new version back.
async function checkHealth(health, deployOutput, options) {
    const resolved = (() => {
        try {
            return { url: resolveHealthUrl(health, parseDeployedUrls(deployOutput)) };
        }
        catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
        }
    })();
    if ('error' in resolved)
        return { ok: false, detail: resolved.error };
    return pollHealth(resolved.url, options.fetch, options.sleep, options.healthAttempts ?? 10, options.healthIntervalMs ?? 6000, options.healthTimeoutMs);
}
async function deployOne(name, component, options) {
    const { run, repoRoot, sha, actor } = options;
    const wranglerEnv = environmentOf(options.manifest, options.environment).wranglerEnv;
    const envArgs = wranglerEnv ? ['--env', wranglerEnv] : [];
    const cwd = join(repoRoot, component.path);
    const short = sha.slice(0, 7);
    const wrangler = (args) => run('pnpm', ['exec', 'wrangler', ...args, ...envArgs], cwd);
    if (component.build) {
        const build = await run('bash', ['-c', component.build], repoRoot);
        if (build.code !== 0)
            return { name, status: 'failed', detail: 'build failed' };
    }
    if (component.migrations) {
        const migrate = await wrangler(['d1', 'migrations', 'apply', component.migrations.d1, '--remote']);
        if (migrate.code !== 0)
            return { name, status: 'failed', detail: 'D1 migrations failed; nothing was deployed' };
    }
    const deploy = await wrangler(['deploy', '--message', `ship ${short} by ${actor}`]);
    if (deploy.code !== 0)
        return { name, status: 'failed', detail: 'wrangler deploy failed' };
    const url = parseDeployedUrls(deploy.output)[0];
    if (!component.health)
        return { name, status: 'deployed', url };
    const health = await checkHealth(component.health, deploy.output, options);
    if (health.ok)
        return { name, status: 'deployed', url, detail: `health check passed: ${health.detail}` };
    const schemaNote = component.migrations ? ' D1 migrations are forward-only and were not undone.' : '';
    const rollback = await wrangler(['rollback', '--yes', '--message', `ship: health check failed for ${short}`]);
    return rollback.code === 0
        ? { name, status: 'rolled-back', url, detail: `${health.detail}. Rolled back to the previous version.${schemaNote}` }
        : { name, status: 'failed', url, detail: `${health.detail}. Rollback also failed: roll back by hand.${schemaNote}` };
}
// Deploys every component in manifest order and stops at the first one that does not deploy.
export async function deployComponents(options) {
    return Object.entries(options.manifest.components).reduce(async (previous, [name, component]) => {
        const results = await previous;
        if (results.some((result) => result.status !== 'deployed'))
            return [...results, { name, status: 'skipped' }];
        return [...results, await deployOne(name, component, options)];
    }, Promise.resolve([]));
}
export function renderSummary(environment, sha, results) {
    const rows = results.map((result) => `| ${result.name} | ${result.status} | ${result.url ?? ''} | ${result.detail ?? ''} |`);
    return [
        `### Ship ${sha.slice(0, 7)} to ${environment}`,
        '',
        '| Component | Result | URL | Detail |',
        '| --- | --- | --- | --- |',
        ...rows,
        '',
    ].join('\n');
}
