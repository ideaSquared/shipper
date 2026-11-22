import { describe, expect, it } from 'vitest';
import {
  deploy,
  diff,
  formatDuration,
  loadContext,
  log,
  pickEnvironment,
  rollback,
  status,
  statusAll,
  type Context,
  type DeployOptions,
  type RollbackOptions,
} from '../src/commands.ts';
import { GitHubApiError, type DeploymentSummary, type GitHubClient, type JobSummary, type RunSummary } from '../src/github.ts';
import { parseManifest } from '../src/manifest.ts';
import { accessHint, RATE_LIMIT_HINT } from '../src/products.ts';
import { plain } from '../src/style.ts';

const HEAD = 'cccccccc11111111cccccccc11111111cccccccc';
const LIVE = 'aaaaaaaa22222222aaaaaaaa22222222aaaaaaaa';

const MANIFEST = `
product: gaminginit-bot
checks: [test]
environments:
  production: {}
dispatch:
  workflow: ci.yml
components:
  bot: { type: cloudflare-worker }
`;

type Fake = Partial<GitHubClient> & { dispatched: { workflow: string; ref: string; inputs: Record<string, string> }[] };

function fakeClient(overrides: Partial<GitHubClient> = {}): Fake {
  const dispatched: Fake['dispatched'] = [];
  const base: GitHubClient = {
    isOnBranch: async () => true,
    checkRuns: async () => [{ name: 'test', status: 'completed', conclusion: 'success' }],
    deployedTo: async () => [],
    deployingTo: async () => [],
    lastSuccessfulDeployment: async () => LIVE,
    relation: async () => 'ahead',
    compare: async () => ({
      totalCommits: 2,
      url: 'https://github.com/acme/app/compare/a...c',
      commits: [
        { sha: 'bbbbbbb0', message: 'older fix', author: 'hubot', url: 'u' },
        { sha: HEAD, message: 'newest feature', author: 'octocat', url: 'u' },
      ],
    }),
    defaultBranch: async () => 'main',
    headSha: async () => HEAD,
    readFile: async () => MANIFEST,
    deployments: async (): Promise<DeploymentSummary[]> => [
      { sha: LIVE, createdAt: '2026-11-13T20:42:50Z', creator: 'octocat', state: 'success' },
      { sha: 'ddddddd0', createdAt: '2026-11-13T19:30:00Z', creator: 'hubot', state: 'inactive' },
    ],
    dispatchWorkflow: async (workflow, ref, inputs) => {
      dispatched.push({ workflow, ref, inputs });
    },
    findDispatchedRun: async (): Promise<RunSummary> => ({
      id: 7,
      status: 'queued',
      conclusion: null,
      url: 'https://github.com/acme/app/actions/runs/7',
      createdAt: '2026-11-13T21:00:01Z',
    }),
    run: async (): Promise<RunSummary> => ({
      id: 7,
      status: 'completed',
      conclusion: 'success',
      url: 'https://github.com/acme/app/actions/runs/7',
      createdAt: '2026-11-13T21:00:01Z',
    }),
    jobs: async (): Promise<JobSummary[]> => [
      { name: 'test', status: 'completed', conclusion: 'success' },
      { name: 'deploy / Deploy (production)', status: 'completed', conclusion: 'success' },
    ],
    createDeployment: async () => 1,
    setDeploymentStatus: async () => {},
    readVariable: async () => undefined,
    writeVariable: async () => {},
    deleteVariable: async () => {},
    currentUser: async () => 'octocat',
    environments: async () => [],
    secretNames: async () => [],
  };
  return Object.assign({ ...base, ...overrides }, { dispatched });
}

function context(client: Fake, manifest = MANIFEST): { ctx: Context; lines: string[] } {
  const lines: string[] = [];
  const ctx: Context = {
    client: client as GitHubClient,
    repo: 'acme/app',
    manifest: parseManifest(manifest),
    defaultBranch: 'main',
    head: HEAD,
    print: (line) => lines.push(line),
    canWrite: true,
    timeZone: 'UTC',
    style: plain,
  };
  return { ctx, lines };
}

const options = (overrides: Partial<DeployOptions & RollbackOptions> = {}): DeployOptions & RollbackOptions => ({
  yes: true,
  wait: true,
  redeploy: false,
  confirm: async () => true,
  ask: async () => 'gaminginit-bot',
  now: () => new Date('2026-11-13T21:00:00Z'),
  sleep: async () => {},
  pollMs: 0,
  findRunAttempts: 2,
  ...overrides,
});

describe('loadContext', () => {
  it('explains when a repo has no ship.yaml', async () => {
    const client = fakeClient({ readFile: async () => undefined });
    await expect(loadContext(client as GitHubClient, 'acme/app', () => {}, true)).rejects.toThrow(
      "acme/app has no ship.yaml on main, so it doesn't deploy with shipper yet.",
    );
  });
});

describe('pickEnvironment', () => {
  it('uses the only environment when none is named, and asks when there are several', () => {
    expect(pickEnvironment(parseManifest(MANIFEST), undefined)).toBe('production');
    const two = parseManifest(MANIFEST.replace('production: {}', 'staging: {}\n  production: {}'));
    expect(() => pickEnvironment(two, undefined)).toThrow('Name an environment: staging, production.');
    expect(() => pickEnvironment(two, 'prod')).toThrow("No environment 'prod' in ship.yaml. It has: staging, production.");
  });
});

describe('status', () => {
  it('shows what is live, when, who shipped it, and how far behind main it is', async () => {
    const { ctx, lines } = context(fakeClient());
    expect(await status(ctx)).toBe(0);
    expect(lines).toEqual(['🚢 gaminginit-bot (acme/app) · main is at ccccccc', '🟡 production   aaaaaaa  13 Nov, 20:42  octocat  2 commits behind']);
  });

  it('says up to date or never deployed', async () => {
    const upToDate = context(fakeClient({ deployments: async () => [{ sha: HEAD, createdAt: '2026-11-13T20:42:50Z', creator: 'o', state: 'success' }] }));
    await status(upToDate.ctx);
    expect(upToDate.lines[1]).toContain('up to date');

    const never = context(fakeClient({ deployments: async () => [] }));
    await status(never.ctx);
    expect(never.lines[1]).toBe('⚪ production   never deployed');
  });
});

describe('checks on the default branch head', () => {
  const running = fakeClient({ checkRuns: async () => [{ name: 'test', status: 'in_progress', conclusion: null }] });
  const failed = fakeClient({ checkRuns: async () => [{ name: 'test', status: 'completed', conclusion: 'failure' }] });

  it('status warns that a deploy would be queued, before anyone tries one', async () => {
    const { ctx, lines } = context(running);
    expect(await status(ctx)).toBe(0);
    expect(lines.slice(2)).toEqual([
      "⏳ ccccccc can't ship yet, a check is still running:",
      "   • check 'test' is still running, so its result is not known yet. Deploy again once it passes.",
      '   A deploy started now is queued until it passes.',
    ]);
  });

  it('status warns that a deploy would be blocked by a check that did not pass', async () => {
    const { ctx, lines } = context(failed);
    await status(ctx);
    expect(lines.slice(2)).toEqual([
      '⛔ ccccccc would be blocked by the gate:',
      "   • check 'test' did not pass. Open the check to see why: fix the code, or re-run the check if it was cancelled or timed out. A deploy can't override it.",
    ]);
  });

  it('status stays quiet when the checks passed, or when head is already live', async () => {
    const passed = context(fakeClient());
    await status(passed.ctx);
    expect(passed.lines).toHaveLength(2);

    const live = context(
      fakeClient({
        checkRuns: running.checkRuns,
        deployments: async () => [{ sha: HEAD, createdAt: '2026-11-13T20:42:50Z', creator: 'o', state: 'success' }],
      }),
    );
    await status(live.ctx);
    expect(live.lines).toHaveLength(2);
  });

  it('status says so when it cannot read the checks, and still shows what is live', async () => {
    const { ctx, lines } = context(
      fakeClient({
        checkRuns: async () => {
          throw new Error('boom');
        },
      }),
    );
    expect(await status(ctx)).toBe(0);
    expect(lines[1]).toContain('production');
    expect(lines[2]).toBe('⚠️  Could not check the default branch head: boom');
  });

  it('diff warns the same way when there are commits waiting', async () => {
    const { ctx, lines } = context(running);
    await diff(ctx, undefined);
    expect(lines.at(-3)).toBe("⏳ ccccccc can't ship yet, a check is still running:");
  });
});

describe('requires and smoke state, shown before a deploy', () => {
  const TWO = MANIFEST.replace('production: {}', 'staging: {}\n  production: { requires: [staging] }');
  const STAGING_LIVE = (state: string): DeploymentSummary[] => [{ sha: LIVE, createdAt: '2026-11-13T20:42:50Z', creator: 'octocat', state }];

  it('status says production needs head live on staging first', async () => {
    const { ctx, lines } = context(fakeClient(), TWO);
    await status(ctx);
    expect(lines.slice(-1)).toEqual(['🔗 production only takes ccccccc once it is live on staging. Run ship deploy gaminginit-bot staging first.']);
  });

  it('status stays quiet about it once head is live on staging', async () => {
    const { ctx, lines } = context(fakeClient({ deployedTo: async () => ['staging'] }), TWO);
    await status(ctx);
    expect(lines.join('\n')).not.toContain('only takes');
  });

  it('diff says the same for the environment it was asked about', async () => {
    const { ctx, lines } = context(fakeClient(), TWO);
    await diff(ctx, 'production');
    expect(lines.at(-1)).toContain('production only takes ccccccc once it is live on staging');
  });

  it('diff shows a freeze that would block the deploy', async () => {
    const frozen = JSON.stringify({ environments: 'all', reason: 'db incident', by: 'octocat', at: '2026-11-13T20:00:00Z' });
    const { ctx, lines } = context(fakeClient({ readVariable: async () => frozen }));
    await diff(ctx, undefined);
    expect(lines.slice(-4)).toEqual([
      '❄️  frozen: all environments',
      '   db incident',
      '   by octocat · 13 Nov, 20:00',
      '   Lift it with ship unfreeze gaminginit-bot production when it is safe.',
    ]);
  });

  it('status flags a release that went live but failed its smoke checks', async () => {
    const { ctx, lines } = context(fakeClient({ deployments: async () => STAGING_LIVE('error') }));
    await status(ctx);
    expect(lines).toContain('   ⚠️  aaaaaaa is live but its smoke checks failed. If the release is at fault, run ship rollback gaminginit-bot production.');
  });

  it('status still flags the live release when a newer attempt failed before deploying', async () => {
    const history: DeploymentSummary[] = [
      { sha: HEAD, createdAt: '2026-11-15T20:42:50Z', creator: 'octocat', state: 'failure' },
      { sha: LIVE, createdAt: '2026-11-14T20:42:50Z', creator: 'octocat', state: 'error' },
      { sha: 'ddddddd0', createdAt: '2026-11-13T20:42:50Z', creator: 'hubot', state: 'success' },
    ];
    const { ctx, lines } = context(fakeClient({ deployments: async () => history }));
    await status(ctx);
    expect(lines[1]).toContain('aaaaaaa');
    expect(lines).toContain('   ⚠️  aaaaaaa is live but its smoke checks failed. If the release is at fault, run ship rollback gaminginit-bot production.');
  });

  it('diff warns about a prerequisite and a freeze for an environment that was never deployed', async () => {
    const frozen = JSON.stringify({ environments: 'all', reason: 'db incident', by: 'octocat', at: '2026-11-13T20:00:00Z' });
    const { ctx, lines } = context(
      fakeClient({ deployments: async () => [], lastSuccessfulDeployment: async () => undefined, readVariable: async () => frozen }),
      TWO,
    );
    await diff(ctx, 'production');
    expect(lines.join('\n')).toContain('production only takes ccccccc once it is live on staging');
    expect(lines.join('\n')).toContain('❄️  frozen: all environments');
  });

  it('diff still shows a freeze when head is already live, but not check or prerequisite warnings', async () => {
    const frozen = JSON.stringify({ environments: 'all', reason: 'db incident', by: 'octocat', at: '2026-11-13T20:00:00Z' });
    const client = fakeClient({
      lastSuccessfulDeployment: async () => HEAD,
      readVariable: async () => frozen,
      checkRuns: async () => [{ name: 'test', status: 'in_progress', conclusion: null }],
    });
    const { ctx, lines } = context(client, TWO);
    await diff(ctx, 'production');
    expect(lines.join('\n')).toContain('❄️  frozen: all environments');
    expect(lines.join('\n')).not.toContain('only takes');
    expect(lines.join('\n')).not.toContain('still running');
  });

  it('status does not flag it once a later deploy went through', async () => {
    const later: DeploymentSummary[] = [{ sha: HEAD, createdAt: '2026-11-14T20:42:50Z', creator: 'octocat', state: 'success' }, ...STAGING_LIVE('error')];
    const { ctx, lines } = context(fakeClient({ deployments: async () => later }));
    await status(ctx);
    expect(lines.join('\n')).not.toContain('smoke checks failed');
  });
});

describe('diff', () => {
  it('lists the commits waiting to ship, newest first', async () => {
    const { ctx, lines } = context(fakeClient());
    await diff(ctx, undefined);
    expect(lines).toEqual([
      '📦 production: aaaaaaa → ccccccc · 2 commits waiting',
      '   ccccccc newest feature · octocat',
      '   bbbbbbb older fix · hubot',
      '🔗 https://github.com/acme/app/compare/a...c',
    ]);
  });
});

describe('pending migrations', () => {
  const WITH_MIGRATIONS = `${MANIFEST}migrations: [packages/db/migrations, services/*/src/migrations]\n`;
  const withFiles = (files: { filename: string; status: string; previousFilename?: string }[]) =>
    fakeClient({
      compare: async () => ({
        totalCommits: 1,
        url: 'https://github.com/acme/app/compare/a...c',
        commits: [{ sha: HEAD, message: 'newest feature', author: 'octocat', url: 'u' }],
        files,
      }),
    });

  it('lists the migration files a diff adds, and ignores other files and subfolders', async () => {
    const { ctx, lines } = context(
      withFiles([
        { filename: 'packages/db/migrations/0012_add_plans.sql', status: 'added' },
        { filename: 'services/auth/src/migrations/004_x.ts', status: 'added' },
        { filename: 'packages/db/migrations/meta/_journal.json', status: 'modified' },
        { filename: 'src/index.ts', status: 'modified' },
        { filename: 'services/auth/src/other/005.ts', status: 'added' },
      ]),
      WITH_MIGRATIONS,
    );
    await diff(ctx, undefined);
    expect(lines).toEqual([
      '📦 production: aaaaaaa → ccccccc · 1 commits waiting',
      '   ccccccc newest feature · octocat',
      '🗄️  2 migrations going out:',
      '   packages/db/migrations/0012_add_plans.sql',
      '   services/auth/src/migrations/004_x.ts',
      '🔗 https://github.com/acme/app/compare/a...c',
    ]);
  });

  it('warns about modified or removed shipped migrations', async () => {
    const { ctx, lines } = context(
      withFiles([
        { filename: 'packages/db/migrations/0001_init.sql', status: 'modified' },
        { filename: 'packages/db/migrations/0002_gone.sql', status: 'removed' },
        { filename: 'packages/db/migrations/0003_moved.sql', status: 'renamed', previousFilename: 'packages/db/migrations/0003_old.sql' },
      ]),
      WITH_MIGRATIONS,
    );
    await diff(ctx, undefined);
    expect(lines.filter((line) => line.startsWith('⚠️'))).toEqual([
      "⚠️  packages/db/migrations/0001_init.sql was changed or removed, but shipped migrations shouldn't change",
      "⚠️  packages/db/migrations/0002_gone.sql was changed or removed, but shipped migrations shouldn't change",
      "⚠️  packages/db/migrations/0003_moved.sql was changed or removed, but shipped migrations shouldn't change",
    ]);
    expect(lines.some((line) => line.includes('going out'))).toBe(false);
  });

  it('prints nothing when there are none, or when ship.yaml has no migrations field', async () => {
    const none = context(withFiles([{ filename: 'src/index.ts', status: 'modified' }]), WITH_MIGRATIONS);
    await diff(none.ctx, undefined);
    const unset = context(withFiles([{ filename: 'packages/db/migrations/0012_x.sql', status: 'added' }]));
    await diff(unset.ctx, undefined);
    expect(none.lines).toHaveLength(3);
    expect(unset.lines).toHaveLength(3);
  });

  it('says there may be more when GitHub capped the file list', async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `src/f${i}.ts`, status: 'modified' }));
    const { ctx, lines } = context(withFiles(files), WITH_MIGRATIONS);
    await diff(ctx, undefined);
    expect(lines).toContain('   …and more, see the compare: https://github.com/acme/app/compare/a...c');
  });

  it('shows them in the deploy preview before asking to confirm', async () => {
    const { ctx, lines } = context(withFiles([{ filename: 'packages/db/migrations/0012_add_plans.sql', status: 'added' }]), WITH_MIGRATIONS);
    await deploy(ctx, undefined, options({ wait: false }));
    expect(lines.slice(1, 5)).toEqual([
      '📦 aaaaaaa → ccccccc · 1 commits',
      '   ccccccc newest feature · octocat',
      '🗄️  1 migration going out:',
      '   packages/db/migrations/0012_add_plans.sql',
    ]);
  });

  it('keeps deploying when the compare fails, with only the existing warning', async () => {
    const client = fakeClient({
      compare: async () => {
        throw new Error('GitHub API returned 502');
      },
    });
    const { ctx, lines } = context(client, WITH_MIGRATIONS);
    expect(await deploy(ctx, undefined, options({ wait: false }))).toBe(0);
    expect(lines.filter((line) => line.includes('migration'))).toEqual([]);
  });
});

describe('log', () => {
  it('lists recent deploys with their state', async () => {
    const { ctx, lines } = context(fakeClient());
    await log(ctx, 'production', 10);
    expect(lines).toEqual(['✅ 13 Nov, 20:42  aaaaaaa  success     octocat', '💤 13 Nov, 19:30  ddddddd  inactive    hubot']);
  });
});

describe('deploy', () => {
  it('checks, starts the workflow on main and follows it to the end', async () => {
    const client = fakeClient();
    const { ctx, lines } = context(client);
    expect(await deploy(ctx, undefined, options())).toBe(0);
    expect(client.dispatched).toEqual([{ workflow: 'ci.yml', ref: 'main', inputs: {} }]);
    expect(lines).toEqual([
      '🔎 Checking ccccccc can ship to production…',
      '📦 aaaaaaa → ccccccc · 2 commits',
      '   ccccccc newest feature · octocat',
      '   bbbbbbb older fix · hubot',
      '',
      '🚨🚨🚨  PRODUCTION  🚨🚨🚨',
      'This changes what real users of gaminginit-bot get, as soon as it finishes.',
      '',
      '📨 Starting ci.yml on main…',
      '⏳ Waiting for GitHub to start the run…',
      '▶️  Started: https://github.com/acme/app/actions/runs/7',
      '   ✅ test: success',
      '   ✅ deploy / Deploy (production): success',
      '🚀 Shipped ccccccc to production. (0s)',
    ]);
  });

  it('passes the environment to workflows that take one', async () => {
    const client = fakeClient();
    const manifest = MANIFEST.replace('workflow: ci.yml', 'workflow: deploy.yml\n  environmentInput: environment');
    const { ctx } = context(client, manifest);
    await deploy(ctx, 'production', options({ wait: false }));
    expect(client.dispatched).toEqual([{ workflow: 'deploy.yml', ref: 'main', inputs: { environment: 'production' } }]);
  });

  it('stops before dispatching when the gate fails', async () => {
    const client = fakeClient({ checkRuns: async () => [{ name: 'test', status: 'completed', conclusion: 'failure' }] });
    const { ctx, lines } = context(client);
    expect(await deploy(ctx, undefined, options())).toBe(1);
    expect(client.dispatched).toEqual([]);
    expect(lines).toEqual([
      '🔎 Checking ccccccc can ship to production…',
      "⛔ Can't ship ccccccc to production:",
      "   • check 'test' did not pass. Open the check to see why: fix the code, or re-run the check if it was cancelled or timed out. A deploy can't override it.",
    ]);
  });

  it('queues a deploy whose checks are still running, and follows the wait and then the jobs', async () => {
    const checks = ['in_progress', 'in_progress', 'completed'];
    const runs: RunSummary['status'][] = ['in_progress', 'in_progress', 'completed'];
    const client = fakeClient({
      checkRuns: async () => {
        const status = checks.shift() ?? 'completed';
        return [{ name: 'test', status, conclusion: status === 'completed' ? 'success' : null }];
      },
      run: async () => {
        const status = runs.shift() ?? 'completed';
        return { id: 7, status, conclusion: status === 'completed' ? 'success' : null, url: 'https://github.com/acme/app/actions/runs/7', createdAt: '' };
      },
      jobs: async () =>
        runs.length > 0
          ? [{ name: 'deploy / Gate (production)', status: 'in_progress', conclusion: null }]
          : [
              { name: 'deploy / Gate (production)', status: 'completed', conclusion: 'success' },
              { name: 'deploy / Deploy (production)', status: 'completed', conclusion: 'success' },
            ],
    });
    const { ctx, lines } = context(client);
    expect(await deploy(ctx, undefined, options())).toBe(0);
    expect(client.dispatched).toHaveLength(1);
    expect(lines[1]).toBe("⏳ ccccccc will be queued: the deploy waits for check 'test' to pass first.");
    const from = lines.indexOf('📨 Starting ci.yml on main…');
    expect(lines.slice(from)).toEqual([
      '📨 Starting ci.yml on main…',
      "🕒 Queued. The workflow's gate waits for check 'test' (30 minutes by default), then deploys.",
      '⏳ Waiting for GitHub to start the run…',
      '▶️  Started: https://github.com/acme/app/actions/runs/7',
      "   ⏳ Waiting for check 'test' · 0s",
      '   ⏳ deploy / Gate (production): in_progress',
      "   ✅ check 'test' passed",
      '   ✅ deploy / Gate (production): success',
      '   ✅ deploy / Deploy (production): success',
      '🚀 Shipped ccccccc to production. (0s)',
    ]);
  });

  it('starts a queued deploy and exits with --no-wait', async () => {
    const client = fakeClient({ checkRuns: async () => [{ name: 'test', status: 'queued', conclusion: null }] });
    const { ctx, lines } = context(client);
    expect(await deploy(ctx, undefined, options({ wait: false }))).toBe(0);
    expect(client.dispatched).toHaveLength(1);
    expect(lines.at(-1)).toBe('▶️  Started: https://github.com/acme/app/actions/runs/7');
    expect(lines).toContain("🕒 Queued. The workflow's gate waits for check 'test' (30 minutes by default), then deploys.");
  });

  it('queues behind a deploy of the same commit to a required environment that is under way', async () => {
    const manifest = MANIFEST.replace('production: {}', 'staging: {}\n  production: { requires: [staging] }');
    const client = fakeClient({ deployingTo: async (_sha, environments) => [...environments] });
    const { ctx, lines } = context(client, manifest);
    expect(await deploy(ctx, 'production', options({ wait: false }))).toBe(0);
    expect(client.dispatched).toHaveLength(1);
    expect(lines[1]).toBe('⏳ ccccccc will be queued: the deploy waits for the staging deploy to pass first.');
  });

  it('refuses when a check is still running but something else blocks it too', async () => {
    const client = fakeClient({
      checkRuns: async () => [{ name: 'test', status: 'in_progress', conclusion: null }],
      relation: async () => 'behind',
    });
    const { ctx, lines } = context(client);
    expect(await deploy(ctx, undefined, options())).toBe(1);
    expect(client.dispatched).toEqual([]);
    expect(lines[1]).toBe("⛔ Can't ship ccccccc to production:");
  });

  it('leaves the run going on Ctrl-C and says so', async () => {
    const stops: (() => void)[] = [];
    const client = fakeClient();
    const { ctx, lines } = context(client);
    const onInterrupt = (stop: () => void) => {
      stops.push(stop);
      return () => {};
    };
    await deploy(ctx, undefined, options({ onInterrupt }));
    stops.at(-1)?.();
    expect(lines.at(-1)).toBe('🛑 Stopped following. The deploy keeps going on GitHub: https://github.com/acme/app/actions/runs/7');
  });

  it('does nothing when the commit is already live, unless asked to redeploy', async () => {
    const client = fakeClient({ lastSuccessfulDeployment: async () => HEAD });
    const { ctx, lines } = context(client);
    expect(await deploy(ctx, undefined, options())).toBe(0);
    expect(client.dispatched).toEqual([]);
    expect(lines[1]).toContain('already live on production');

    await deploy(ctx, undefined, options({ redeploy: true, wait: false }));
    expect(client.dispatched).toHaveLength(1);
  });

  it('does not dispatch when the person says no', async () => {
    const client = fakeClient();
    const { ctx, lines } = context(client);
    expect(await deploy(ctx, undefined, options({ yes: false, confirm: async () => false }))).toBe(1);
    expect(client.dispatched).toEqual([]);
    expect(lines.at(-1)).toBe('🙅 Not shipped.');
  });

  it('reports a failed run with its link', async () => {
    const client = fakeClient({
      run: async () => ({ id: 7, status: 'completed', conclusion: 'failure', url: 'https://run/7', createdAt: '' }),
      jobs: async () => [{ name: 'deploy / Deploy (production)', status: 'completed', conclusion: 'failure' }],
    });
    const { ctx, lines } = context(client);
    expect(await deploy(ctx, undefined, options())).toBe(1);
    expect(lines.at(-1)).toBe('💥 Deploy failure: https://run/7 (0s)');
  });

  it('names the job and step that failed, before the link to the run', async () => {
    const client = fakeClient({
      run: async () => ({ id: 7, status: 'completed', conclusion: 'failure', url: 'https://run/7', createdAt: '' }),
      jobs: async () => [
        { name: 'gate', status: 'completed', conclusion: 'success' },
        {
          name: 'deploy / Deploy (production)',
          status: 'completed',
          conclusion: 'failure',
          steps: [
            { name: 'Checkout', status: 'completed', conclusion: 'success' },
            { name: 'Deploy to Cloudflare', status: 'completed', conclusion: 'failure' },
          ],
        },
      ],
    });
    const { ctx, lines } = context(client);
    expect(await deploy(ctx, undefined, options())).toBe(1);
    expect(lines.slice(-2)).toEqual(['   ❌ deploy / Deploy (production) › Deploy to Cloudflare', '💥 Deploy failure: https://run/7 (0s)']);
  });

  it('needs a dispatch workflow and a token', async () => {
    const noDispatch = context(fakeClient(), MANIFEST.replace(/dispatch:\n {2}workflow: ci.yml\n/, ''));
    await expect(deploy(noDispatch.ctx, undefined, options())).rejects.toThrow('ship.yaml has no dispatch.workflow');

    const readOnly = context(fakeClient());
    await expect(deploy({ ...readOnly.ctx, canWrite: false }, undefined, options())).rejects.toThrow('needs a GitHub token');
  });

  it('colours by meaning when the terminal supports it', async () => {
    const tag = (name: string) => (text: string) => `<${name}>${text}</${name}>`;
    const style = { ok: tag('ok'), warn: tag('warn'), bad: tag('bad'), dim: tag('dim'), bold: tag('b'), sha: tag('sha'), env: tag('env'), link: tag('link') };
    const failing = fakeClient({ checkRuns: async () => [{ name: 'test', status: 'completed', conclusion: 'failure' }] });
    const { ctx, lines } = context(failing);
    await deploy({ ...ctx, style }, undefined, options());
    expect(lines).toEqual([
      '🔎 <dim>Checking ccccccc can ship to production…</dim>',
      "⛔ <bad>Can't ship ccccccc to production:</bad>",
      "   • <bad>check 'test' did not pass. Open the check to see why: fix the code, or re-run the check if it was cancelled or timed out. A deploy can't override it.</bad>",
    ]);
  });

  it('refuses to put an older commit over what is live', async () => {
    const client = fakeClient({ relation: async () => 'behind' });
    const { ctx, lines } = context(client);
    expect(await deploy(ctx, undefined, options())).toBe(1);
    expect(client.dispatched).toEqual([]);
    expect(lines).toEqual([
      '🔎 Checking ccccccc can ship to production…',
      "⛔ Can't ship ccccccc to production:",
      '   • ccccccc is older than aaaaaaa, which is live on production. If an old run was re-run, deploy the latest commit instead. To go back on purpose, use ship rollback gaminginit-bot production.',
    ]);
  });

  it('still deploys when GitHub cannot compare the commits, and says so', async () => {
    const client = fakeClient({
      relation: async () => {
        throw new Error('GitHub API returned 502');
      },
      compare: async () => {
        throw new Error('GitHub API returned 502');
      },
    });
    const { ctx, lines } = context(client);
    expect(await deploy(ctx, undefined, options({ wait: false }))).toBe(0);
    expect(client.dispatched).toHaveLength(1);
    expect(lines.slice(0, 4)).toEqual([
      '🔎 Checking ccccccc can ship to production…',
      '⚠️  Could not compare ccccccc with the live aaaaaaa: GitHub API returned 502',
      '⚠️  Could not list the commits going out: GitHub API returned 502',
      '📦 aaaaaaa → ccccccc',
    ]);
  });

  it('shows every product in list order, and explains one it cannot read', async () => {
    const lines: string[] = [];
    const load = async (repo: string, out: (line: string) => void): Promise<Context> => {
      if (repo === 'acme/missing') throw new Error('acme/missing has no ship.yaml on main');
      return { ...context(fakeClient()).ctx, repo, print: out };
    };
    await statusAll({ app: 'acme/app', missing: 'acme/missing' }, load, (line) => lines.push(line), plain);
    expect(lines).toEqual([
      '🚢 gaminginit-bot (acme/app) · main is at ccccccc',
      '🟡 production   aaaaaaa  13 Nov, 20:42  octocat  2 commits behind',
      '',
      '⚠️  missing (acme/missing): acme/missing has no ship.yaml on main',
    ]);
  });

  it('hints at access or the rate limit for a product GitHub refuses', async () => {
    const lines: string[] = [];
    const load = async (repo: string): Promise<Context> => {
      if (repo === 'acme/private') throw new GitHubApiError('GitHub API / returned 404: Not Found', 404);
      throw new GitHubApiError('GitHub API / returned 403: API rate limit exceeded', 403, true);
    };
    await statusAll({ secret: 'acme/private', busy: 'acme/busy' }, load, (line) => lines.push(line), plain);
    expect(lines).toEqual([
      '⚠️  secret (acme/private): GitHub API / returned 404: Not Found',
      `   🔑 ${accessHint('acme/private', undefined)}`,
      '',
      '⚠️  busy (acme/busy): GitHub API / returned 403: API rate limit exceeded',
      `   ⏳ ${RATE_LIMIT_HINT}`,
    ]);
  });

  it('replaces a product that fails part-way with one warning line', async () => {
    const lines: string[] = [];
    const broken = fakeClient({
      deployments: async () => {
        throw new Error('GitHub API returned 500');
      },
    });
    const load = async (repo: string, out: (line: string) => void): Promise<Context> => ({
      ...context(broken).ctx,
      repo,
      print: out,
    });
    await statusAll({ app: 'acme/app' }, load, (line) => lines.push(line), plain);
    expect(lines).toEqual(['⚠️  app (acme/app): GitHub API returned 500']);
  });
});

describe('following a deploy', () => {
  const job = (status: string, step?: string, conclusion: string | null = null): JobSummary => ({
    name: 'deploy',
    status,
    conclusion,
    steps: step
      ? [
          { name: 'Set up job', status: 'completed', conclusion: 'success' },
          { name: step, status: 'in_progress', conclusion: null },
        ]
      : [],
  });

  it('shows the step each job is on, a heartbeat when nothing changes for a minute, and the total time', async () => {
    const polls: { run: string; jobs: JobSummary[]; at: number }[] = [
      { run: 'in_progress', jobs: [job('in_progress', 'Pull images')], at: 10 },
      { run: 'in_progress', jobs: [job('in_progress', 'Pull images')], at: 40 },
      { run: 'in_progress', jobs: [job('in_progress', 'Pull images')], at: 75 },
      { run: 'in_progress', jobs: [job('in_progress', 'Start the stack')], at: 90 },
      { run: 'completed', jobs: [job('completed', undefined, 'success')], at: 130 },
    ];
    let poll = -1;
    let clock = 0;
    const client = fakeClient({
      run: async () => {
        poll += 1;
        clock = polls[poll]?.at ?? clock;
        const state = polls[poll]?.run ?? 'completed';
        return { id: 7, status: state, conclusion: state === 'completed' ? 'success' : null, url: 'https://run/7', createdAt: '' };
      },
      jobs: async () => polls[poll]?.jobs ?? [],
    });
    const { ctx, lines } = context(client);
    const now = () => new Date(Date.UTC(2026, 10, 13, 21, 0, clock));
    expect(await deploy(ctx, undefined, options({ now }))).toBe(0);
    const from = lines.indexOf('▶️  Started: https://github.com/acme/app/actions/runs/7') + 1;
    expect(lines.slice(from)).toEqual([
      '   ⏳ deploy: in_progress',
      '      ↳ Pull images',
      '   ⏱️  Still running · 1m 15s · deploy › Pull images',
      '      ↳ deploy › Start the stack',
      '   ✅ deploy: success',
      '🚀 Shipped ccccccc to production. (2m 10s)',
    ]);
  });
  it('counts the total from the dispatch, including the wait for the run to appear', async () => {
    let clock = 0;
    const client = fakeClient({
      findDispatchedRun: async () => {
        clock = 45;
        return { id: 7, status: 'queued', conclusion: null, url: 'https://github.com/acme/app/actions/runs/7', createdAt: '' };
      },
      run: async () => {
        clock = 55;
        return { id: 7, status: 'completed', conclusion: 'success', url: 'https://run/7', createdAt: '' };
      },
      jobs: async () => [job('completed', undefined, 'success')],
    });
    const { ctx, lines } = context(client);
    const now = () => new Date(Date.UTC(2026, 10, 13, 21, 0, clock));
    expect(await deploy(ctx, undefined, options({ now }))).toBe(0);
    expect(lines.at(-1)).toBe('🚀 Shipped ccccccc to production. (55s)');
  });
});

describe('formatDuration', () => {
  it('reads as minutes and seconds', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(59_400)).toBe('59s');
    expect(formatDuration(130_000)).toBe('2m 10s');
  });
});

describe('rollback', () => {
  const OLDER = 'dddddddd33333333dddddddd33333333dddddddd';
  const OLDEST = 'eeeeeeee44444444eeeeeeee44444444eeeeeeee';
  const history = async (): Promise<DeploymentSummary[]> => [
    { sha: 'fffffff0', createdAt: '2026-11-13T21:00:00Z', creator: 'o', state: 'failure' },
    { sha: LIVE, createdAt: '2026-11-13T20:42:50Z', creator: 'octocat', state: 'success' },
    { sha: LIVE, createdAt: '2026-11-13T20:00:00Z', creator: 'octocat', state: 'inactive' },
    { sha: OLDER, createdAt: '2026-11-13T19:30:00Z', creator: 'hubot', state: 'inactive' },
    { sha: OLDEST, createdAt: '2026-11-12T19:30:00Z', creator: 'hubot', state: 'inactive' },
  ];
  const takenOut = async () => ({
    totalCommits: 1,
    url: 'u',
    commits: [{ sha: LIVE, message: 'broke it', author: 'octocat', url: 'u' }],
  });

  it('puts back the commit live before the live one, through the rollback workflow, and follows it', async () => {
    const client = fakeClient({ deployments: history, compare: takenOut });
    const { ctx, lines } = context(client);
    expect(await rollback(ctx, undefined, options())).toBe(0);
    expect(client.dispatched).toEqual([{ workflow: 'ship-rollback.yml', ref: 'main', inputs: { environment: 'production', sha: OLDER } }]);
    expect(lines).toEqual([
      '⏪ live aaaaaaa → ddddddd · 1 commits taken out',
      '   aaaaaaa broke it · octocat',
      '',
      '🚨🚨🚨  PRODUCTION  🚨🚨🚨',
      'This changes what real users of gaminginit-bot get, as soon as it finishes.',
      '',
      '⏳ Waiting for GitHub to start the run…',
      '▶️  Started: https://github.com/acme/app/actions/runs/7',
      '   ✅ test: success',
      '   ✅ deploy / Deploy (production): success',
      '⏪ Rolled production back to ddddddd. (0s)',
    ]);
  });

  it('takes --to, by SHA prefix, only for a commit that was live on that environment', async () => {
    const client = fakeClient({ deployments: history, compare: takenOut });
    const { ctx } = context(client);
    await rollback(ctx, undefined, options({ to: 'eeeeeeee4', wait: false }));
    expect(client.dispatched[0]?.inputs.sha).toBe(OLDEST);
    await expect(rollback(ctx, undefined, options({ to: 'fffffff0' }))).rejects.toThrow(
      "fffffff0 was never live on production in its recent deploys, so it can't be a rollback target",
    );
    await expect(rollback(ctx, undefined, options({ to: 'aaaaaaa' }))).rejects.toThrow('aaaaaaa is already live on production');
    await expect(rollback(ctx, undefined, options({ to: 'eee' }))).rejects.toThrow('at least 7 characters');
  });

  it('rolls back from a release whose smoke checks failed to the last healthy one', async () => {
    // LIVE is the last `success`; a newer release went live but failed its smoke checks (`error`).
    const smokeFailed = async (): Promise<DeploymentSummary[]> => [
      { sha: 'fffffff0', createdAt: '2026-11-13T21:00:00Z', creator: 'o', state: 'error' },
      ...(await history()).slice(1),
    ];
    const client = fakeClient({ deployments: smokeFailed, compare: takenOut });
    const { ctx, lines } = context(client);
    await rollback(ctx, undefined, options({ wait: false }));
    expect(client.dispatched[0]?.inputs.sha).toBe(LIVE);
    expect(lines[0]).toContain('live fffffff → aaaaaaa');
  });

  it('uses the rollback workflow named in ship.yaml', async () => {
    const client = fakeClient({ deployments: history, compare: takenOut });
    const { ctx } = context(client, MANIFEST.replace('workflow: ci.yml', 'workflow: ci.yml\n  rollbackWorkflow: undo.yml'));
    await rollback(ctx, undefined, options({ wait: false }));
    expect(client.dispatched[0]?.workflow).toBe('undo.yml');
  });

  it('asks first, and does nothing on no', async () => {
    const client = fakeClient({ deployments: history, compare: takenOut });
    const { ctx, lines } = context(client);
    const asked: string[] = [];
    const confirm = async (question: string) => {
      asked.push(question);
      return false;
    };
    expect(await rollback(ctx, undefined, options({ yes: false, confirm }))).toBe(1);
    expect(asked).toEqual(['⏪ Roll production back to ddddddd?']);
    expect(client.dispatched).toEqual([]);
    expect(lines.at(-1)).toBe('🙅 Not rolled back.');
  });

  it('explains when there is nothing to roll back to', async () => {
    const never = context(fakeClient({ lastSuccessfulDeployment: async () => undefined }));
    await expect(rollback(never.ctx, undefined, options())).rejects.toThrow('production has never been deployed');
    const once = context(fakeClient({ deployments: async () => [{ sha: LIVE, createdAt: '', creator: 'o', state: 'success' }] }));
    await expect(rollback(once.ctx, undefined, options())).rejects.toThrow('No earlier deploy of production to roll back to.');
  });

  it('shows the workflow to add when the repo has no rollback workflow', async () => {
    const client = fakeClient({
      deployments: history,
      compare: takenOut,
      dispatchWorkflow: async () => {
        throw new GitHubApiError('GitHub API /actions/workflows/ship-rollback.yml/dispatches returned 404: Not Found', 404);
      },
    });
    const { ctx } = context(client);
    const error = await rollback(ctx, undefined, options()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('This repo has no .github/workflows/ship-rollback.yml to roll back with');
    expect(String(error)).toContain('      rollback: true');
    expect(String(error)).toContain('deploy.yml@<full-commit-sha> # v1.x');
    expect(String(error)).toContain('shipper-ref: <full-commit-sha> # v1.x');
    expect(String(error)).not.toContain('deploy.yml@v1');
  });
});

describe('production safety', () => {
  it('shows a production warning and needs the product name typed back, even with --yes', async () => {
    const asked: string[] = [];
    const client = fakeClient();
    const { ctx, lines } = context(client);
    expect(await deploy(ctx, 'production', options({ wait: false, ask: async (question) => (asked.push(question), 'gaminginit') }))).toBe(1);
    expect(lines).toContain('🚨🚨🚨  PRODUCTION  🚨🚨🚨');
    expect(asked).toHaveLength(1);
    expect(lines.slice(-2)).toEqual(["🙅 That isn't gaminginit-bot.", '🙅 Not shipped.']);
    expect(client.dispatched).toEqual([]);
  });

  it('deploys production once the name is typed', async () => {
    const client = fakeClient();
    const { ctx } = context(client);
    expect(await deploy(ctx, 'production', options({ wait: false }))).toBe(0);
    expect(client.dispatched).toHaveLength(1);
  });
});

describe('a freeze', () => {
  const FROZEN = JSON.stringify({ environments: 'all', reason: 'db incident', by: 'octocat', at: '2026-11-13T20:00:00Z' });
  const frozen = () => fakeClient({ readVariable: async () => FROZEN });

  it('stops ship deploy before anything is started, with the reason, who and when', async () => {
    const client = frozen();
    const { ctx, lines } = context(client);
    expect(await deploy(ctx, undefined, options())).toBe(1);
    expect(client.dispatched).toEqual([]);
    expect(lines).toEqual([
      '❄️  production is frozen. Not deploying.',
      '   db incident',
      '   by octocat · 13 Nov, 20:00',
      '   Lift it with ship unfreeze gaminginit-bot production when it is safe.',
    ]);
  });

  it('does not stop a deploy to an environment it does not cover', async () => {
    const client = fakeClient({ readVariable: async () => FROZEN.replace('"all"', '["staging"]') });
    expect(await deploy(context(client).ctx, undefined, options())).toBe(0);
    expect(client.dispatched).toHaveLength(1);
  });

  it('still lets ship rollback through, and prints it', async () => {
    const client = fakeClient({
      readVariable: async () => FROZEN,
      deployments: async () => [
        { sha: LIVE, createdAt: '2026-11-13T20:42:50Z', creator: 'o', state: 'success' },
        { sha: 'dddddddd33333333dddddddd33333333dddddddd', createdAt: '2026-11-13T19:30:00Z', creator: 'o', state: 'inactive' },
      ],
    });
    const { ctx, lines } = context(client);
    expect(await rollback(ctx, undefined, options())).toBe(0);
    expect(client.dispatched).toHaveLength(1);
    expect(lines).toContain('❄️  frozen: all environments');
  });

  it('shows in ship status', async () => {
    const { ctx, lines } = context(frozen());
    await status(ctx);
    expect(lines.slice(-3)).toEqual(['❄️  frozen: all environments', '   db incident', '   by octocat · 13 Nov, 20:00']);
  });

  it('is not an error to be unable to read it: deploy carries on, with a warning only for real failures', async () => {
    const denied = fakeClient({ readVariable: async () => Promise.reject(new GitHubApiError('no', 403)) });
    const { ctx, lines } = context(denied);
    expect(await deploy(ctx, undefined, options())).toBe(0);
    expect(lines.some((line) => line.includes('Could not check for a freeze'))).toBe(false);

    const broken = fakeClient({ readVariable: async () => Promise.reject(new GitHubApiError('boom', 500)) });
    const second = context(broken);
    expect(await deploy(second.ctx, undefined, options())).toBe(0);
    expect(second.lines[0]).toContain('Could not check for a freeze');
  });

  it('never lets a garbage variable stop a rollback', async () => {
    const client = fakeClient({
      readVariable: async () => 'nope',
      deployments: async () => [
        { sha: LIVE, createdAt: '2026-11-13T20:42:50Z', creator: 'o', state: 'success' },
        { sha: 'dddddddd33333333dddddddd33333333dddddddd', createdAt: '2026-11-13T19:30:00Z', creator: 'o', state: 'inactive' },
      ],
    });
    const { ctx, lines } = context(client);
    expect(await rollback(ctx, undefined, options())).toBe(0);
    expect(client.dispatched).toHaveLength(1);
    expect(lines[0]).toContain('Could not check for a freeze: SHIP_FREEZE is not a valid freeze');
  });

  it('refuses a deploy when the variable is garbage rather than guessing', async () => {
    const client = fakeClient({ readVariable: async () => 'nope' });
    await expect(deploy(context(client).ctx, undefined, options())).rejects.toThrow('SHIP_FREEZE is not a valid freeze');
  });
});
