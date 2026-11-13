import { describe, expect, it } from 'vitest';
import {
  deploy,
  diff,
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
    expect(lines).toEqual([
      '🚢 gaminginit-bot (acme/app) · main is at ccccccc',
      '🟡 production   aaaaaaa  13 Nov, 20:42  octocat  2 commits behind',
    ]);
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
      '📦 aaaaaaa → ccccccc · 2 commits',
      '   ccccccc newest feature · octocat',
      '   bbbbbbb older fix · hubot',
      '',
      '🚨🚨🚨  PRODUCTION  🚨🚨🚨',
      'This changes what real users of gaminginit-bot get, as soon as it finishes.',
      '',
      '▶️  Started: https://github.com/acme/app/actions/runs/7',
      '   ✅ test: success',
      '   ✅ deploy / Deploy (production): success',
      '🚀 Shipped ccccccc to production.',
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
    expect(lines).toEqual(["⛔ Can't ship ccccccc to production:", "   • check 'test' did not pass"]);
  });

  it('does nothing when the commit is already live, unless asked to redeploy', async () => {
    const client = fakeClient({ lastSuccessfulDeployment: async () => HEAD });
    const { ctx, lines } = context(client);
    expect(await deploy(ctx, undefined, options())).toBe(0);
    expect(client.dispatched).toEqual([]);
    expect(lines[0]).toContain('already live on production');

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
    expect(lines.at(-1)).toBe('💥 Deploy failure: https://run/7');
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
    expect(lines).toEqual(["⛔ <bad>Can't ship ccccccc to production:</bad>", "   • <bad>check 'test' did not pass</bad>"]);
  });

  it('refuses to put an older commit over what is live', async () => {
    const client = fakeClient({ relation: async () => 'behind' });
    const { ctx, lines } = context(client);
    expect(await deploy(ctx, undefined, options())).toBe(1);
    expect(client.dispatched).toEqual([]);
    expect(lines).toEqual(["⛔ Can't ship ccccccc to production:", '   • ccccccc is older than aaaaaaa, which is live on production']);
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
    expect(lines.slice(0, 3)).toEqual([
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
      '▶️  Started: https://github.com/acme/app/actions/runs/7',
      '   ✅ test: success',
      '   ✅ deploy / Deploy (production): success',
      '⏪ Rolled production back to ddddddd.',
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
  });
});

describe('production safety', () => {
  it('shows a production warning and needs the product name typed back, even with --yes', async () => {
    const asked: string[] = [];
    const client = fakeClient();
    const { ctx, lines } = context(client);
    expect(
      await deploy(
        ctx,
        'production',
        options({ wait: false, ask: async (question) => (asked.push(question), 'gaminginit') }),
      ),
    ).toBe(1);
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

