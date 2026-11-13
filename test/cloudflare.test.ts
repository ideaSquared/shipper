import { describe, expect, it } from 'vitest';
import {
  deployComponents,
  parseDeployedUrls,
  pollHealth,
  renderSummary,
  resolveHealthUrl,
  type Run,
} from '../src/cloudflare.ts';
import { parseManifest } from '../src/manifest.ts';

const SHA = 'abcdef1234567890abcdef1234567890abcdef12';

const WRANGLER_OUTPUT = `
Total Upload: 120.50 KiB / gzip: 30.10 KiB
Uploaded wardogs-discord-bot (3.21 sec)
Deployed wardogs-discord-bot triggers (0.80 sec)
  https://wardogs-discord-bot.example.workers.dev
  schedule: * * * * *
Current Version ID: 1111-2222
`;

type Call = { command: string; args: readonly string[]; cwd: string; env?: Readonly<Record<string, string>> };

function fakeRun(fail: (call: Call) => boolean = () => false): { run: Run; calls: Call[] } {
  const calls: Call[] = [];
  const run: Run = async (command, args, cwd, env) => {
    const call = env ? { command, args, cwd, env } : { command, args, cwd };
    calls.push(call);
    if (fail(call)) return { code: 1, output: 'boom' };
    return { code: 0, output: args.includes('deploy') ? WRANGLER_OUTPUT : '' };
  };
  return { run, calls };
}

const respond = (status: number): typeof fetch => async () => new Response(null, { status });
const noSleep = async () => {};

function options(manifestText: string, run: Run, fetchImpl: typeof fetch = respond(200)) {
  return {
    manifest: parseManifest(manifestText),
    environment: 'production',
    sha: SHA,
    actor: 'octocat',
    repoRoot: '/repo',
    run,
    fetch: fetchImpl,
    sleep: noSleep,
    healthAttempts: 2,
    healthIntervalMs: 0,
  };
}

const SINGLE = `
product: gaminginit-bot
environments: { production: {} }
components:
  bot: { type: cloudflare-worker, health: /api/stats }
`;

describe('parseDeployedUrls', () => {
  it('ignores URLs in the bindings table that wrangler prints before the deploy URL', () => {
    const output = `Your Worker has access to the following bindings:
Binding                                         Resource
env.DISCORD_INVITE ("https://discord.gg/abc123")  Environment Variable
env.STATS_URL ("https://example.com/api/stats")   Environment Variable

Uploaded wardogs-discord-bot (2.53 sec)
Deployed wardogs-discord-bot triggers (0.77 sec)
  https://wardogs-discord-bot.idea-squared.workers.dev
  schedule: * * * * *
Current Version ID: 00d2fe82-e759-4e2e-962f-88c31d47903f`;
    expect(parseDeployedUrls(output)).toEqual(['https://wardogs-discord-bot.idea-squared.workers.dev']);
  });

  it('finds the Worker URL and ignores Cloudflare doc links', () => {
    const output = `${WRANGLER_OUTPUT}See https://developers.cloudflare.com/workers/ for more.`;
    expect(parseDeployedUrls(output)).toEqual(['https://wardogs-discord-bot.example.workers.dev']);
  });
});

describe('resolveHealthUrl', () => {
  it('puts a path on the deployed URL', () => {
    expect(resolveHealthUrl('/api/stats', ['https://bot.example.workers.dev'])).toBe(
      'https://bot.example.workers.dev/api/stats',
    );
  });

  it('keeps a full URL as it is', () => {
    expect(resolveHealthUrl('https://example.com/health', [])).toBe('https://example.com/health');
  });

  it('explains when a path has no URL to go on', () => {
    expect(() => resolveHealthUrl('/health', [])).toThrow(/use a full URL/);
  });
});

describe('pollHealth', () => {
  it('retries until the endpoint answers', async () => {
    const statuses = [503, 200];
    const fetchImpl: typeof fetch = async () => new Response(null, { status: statuses.shift() ?? 500 });
    expect((await pollHealth('https://x.dev/h', fetchImpl, noSleep, 3, 0)).ok).toBe(true);
  });

  it('treats a request that never answers as a failed attempt', async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    const result = await pollHealth('https://x.dev/h', hang, noSleep, 2, 0, 20);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/failed 2 times/);
  });

  it('gives up after the last attempt and says why', async () => {
    const result = await pollHealth('https://x.dev/h', respond(500), noSleep, 2, 0);
    expect(result).toEqual({ ok: false, detail: 'https://x.dev/h failed 2 times, last: HTTP 500' });
  });
});

describe('deployComponents', () => {
  it('deploys with a message naming the commit and who shipped it', async () => {
    const { run, calls } = fakeRun();
    const results = await deployComponents(options(SINGLE, run));
    expect(results).toEqual([
      {
        name: 'bot',
        status: 'deployed',
        url: 'https://wardogs-discord-bot.example.workers.dev',
        detail: 'health check passed: https://wardogs-discord-bot.example.workers.dev/api/stats answered',
      },
    ]);
    expect(calls).toEqual([
      { command: 'pnpm', args: ['exec', 'wrangler', 'deploy', '--message', 'ship abcdef1 by octocat'], cwd: '/repo' },
    ]);
  });

  it('builds, migrates and deploys in that order with the wrangler env', async () => {
    const { run, calls } = fakeRun();
    await deployComponents(
      options(
        `
product: creatrgrid
environments: { production: { wranglerEnv: production } }
components:
  api: { type: cloudflare-worker, path: services/api, build: pnpm build, migrations: { d1: cg-db } }
`,
        run,
      ),
    );
    expect(calls.map((call) => [call.command, ...call.args].join(' '))).toEqual([
      'bash -c pnpm build',
      'pnpm exec wrangler d1 migrations apply cg-db --remote --env production',
      'pnpm exec wrangler deploy --message ship abcdef1 by octocat --env production',
    ]);
    expect(calls.map((call) => call.cwd)).toEqual(['/repo', '/repo/services/api', '/repo/services/api']);
  });

  it('tells the build which environment it is building for', async () => {
    const { run, calls } = fakeRun();
    const manifest = `
product: creatrgrid
environments: { staging: { wranglerEnv: staging }, production: {} }
components: { web: { type: cloudflare-worker, build: pnpm build } }
`;
    await deployComponents({ ...options(manifest, run), environment: 'staging' });
    await deployComponents(options(manifest, run));
    expect(calls.filter((call) => call.command === 'bash').map((call) => call.env)).toEqual([
      { SHIP_ENVIRONMENT: 'staging', SHIP_WRANGLER_ENV: 'staging' },
      { SHIP_ENVIRONMENT: 'production', SHIP_WRANGLER_ENV: '' },
    ]);
  });

  it('checks the health URL set for the environment, and skips the check where none is set', async () => {
    const manifest = `
product: creatrgrid
environments: { staging: {}, production: {} }
components:
  api: { type: cloudflare-worker, health: { production: https://api.example.com/health } }
`;
    const checked: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      checked.push(String(input));
      return new Response(null, { status: 200 });
    };
    const production = await deployComponents(options(manifest, fakeRun().run, fetchImpl));
    expect(production[0]?.detail).toBe('health check passed: https://api.example.com/health answered');
    const staging = await deployComponents({ ...options(manifest, fakeRun().run, fetchImpl), environment: 'staging' });
    expect(staging[0]).toEqual({
      name: 'api',
      status: 'deployed',
      url: 'https://wardogs-discord-bot.example.workers.dev',
      detail: 'no health check for staging',
    });
    expect(checked).toEqual(['https://api.example.com/health']);
  });

  it('does not deploy when migrations fail', async () => {
    const { run, calls } = fakeRun((call) => call.args.includes('migrations'));
    const results = await deployComponents(
      options(
        `
product: x
environments: { production: {} }
components: { api: { type: cloudflare-worker, migrations: { d1: db } } }
`,
        run,
      ),
    );
    expect(results[0]?.status).toBe('failed');
    expect(calls.some((call) => call.args.includes('deploy'))).toBe(false);
  });

  it('rolls back when the health check keeps failing', async () => {
    const { run, calls } = fakeRun();
    const results = await deployComponents(options(SINGLE, run, respond(500)));
    expect(results[0]?.status).toBe('rolled-back');
    expect(results[0]?.detail).toMatch(/Rolled back to the previous version/);
    expect(calls.at(-1)?.args).toEqual([
      'exec',
      'wrangler',
      'rollback',
      '--yes',
      '--message',
      'ship: health check failed for abcdef1',
    ]);
  });

  it('rolls back when it cannot tell which URL to check', async () => {
    const calls: { args: readonly string[] }[] = [];
    const run: Run = async (_command, args) => {
      calls.push({ args });
      return { code: 0, output: args.includes('deploy') ? 'Uploaded bot\nNo URL printed' : '' };
    };
    const results = await deployComponents(options(SINGLE, run));
    expect(results[0]?.status).toBe('rolled-back');
    expect(results[0]?.detail).toMatch(/wrangler printed no URL/);
    expect(calls.at(-1)?.args).toContain('rollback');
  });

  it('stops at the first failure and skips the rest', async () => {
    const { run, calls } = fakeRun((call) => call.cwd === '/repo/services/api' && call.args.includes('deploy'));
    const results = await deployComponents(
      options(
        `
product: x
environments: { production: {} }
components:
  api: { type: cloudflare-worker, path: services/api }
  web: { type: cloudflare-worker, path: apps/web }
`,
        run,
      ),
    );
    expect(results.map((result) => result.status)).toEqual(['failed', 'skipped']);
    expect(calls.some((call) => call.cwd === '/repo/apps/web')).toBe(false);
  });
});

describe('renderSummary', () => {
  it('lists each component and what happened to it', () => {
    expect(renderSummary('production', SHA, [{ name: 'bot', status: 'deployed', url: 'https://b.dev' }])).toContain(
      '| bot | deployed | https://b.dev |  |',
    );
  });
});
