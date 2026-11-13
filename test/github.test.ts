import { describe, expect, it } from 'vitest';
import { createGitHubClient, GitHubApiError } from '../src/github.ts';

function fakeFetch(routes: Record<string, unknown>): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    const path = url.replace('https://api.github.com/repos/acme/app', '');
    if (!(path in routes)) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(routes[path]), { status: 200 });
  };
  return { fetch: fetchImpl, urls };
}

describe('createGitHubClient', () => {
  it('counts a commit as on the branch when the branch contains it', async () => {
    const { fetch } = fakeFetch({
      '/compare/main...aaa': { status: 'behind' },
      '/compare/main...bbb': { status: 'identical' },
      '/compare/main...ccc': { status: 'diverged' },
    });
    const github = createGitHubClient('acme/app', 'token', fetch);
    expect(await github.isOnBranch('aaa', 'main')).toBe(true);
    expect(await github.isOnBranch('bbb', 'main')).toBe(true);
    expect(await github.isOnBranch('ccc', 'main')).toBe(false);
  });

  it('lists only the environments with a successful deployment of the commit', async () => {
    const { fetch } = fakeFetch({
      '/deployments?sha=aaa&environment=staging&per_page=100': [{ id: 1 }, { id: 2 }],
      '/deployments/1/statuses?per_page=100': [{ state: 'failure' }],
      '/deployments/2/statuses?per_page=100': [{ state: 'in_progress' }, { state: 'success' }],
      '/deployments?sha=aaa&environment=qa&per_page=100': [{ id: 3 }],
      '/deployments/3/statuses?per_page=100': [{ state: 'failure' }],
    });
    const github = createGitHubClient('acme/app', 'token', fetch);
    expect(await github.deployedTo('aaa', ['staging', 'qa'])).toEqual(['staging']);
  });

  it('says which API call failed', async () => {
    const { fetch } = fakeFetch({});
    const github = createGitHubClient('acme/app', 'token', fetch);
    await expect(github.checkRuns('aaa')).rejects.toThrow('GitHub API /commits/aaa/check-runs?per_page=100 returned 404');
  });

  it('reads every page of check runs and deployment statuses', async () => {
    const pages: Record<string, { body: unknown; next?: string }> = {
      '/commits/aaa/check-runs?per_page=100': {
        body: { check_runs: [{ name: 'lint', status: 'completed', conclusion: 'success' }] },
        next: 'https://api.github.com/repositories/1/commits/aaa/check-runs?per_page=100&page=2',
      },
      '/repositories/1/commits/aaa/check-runs?per_page=100&page=2': {
        body: { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] },
      },
      '/deployments?sha=aaa&environment=staging&per_page=100': { body: [{ id: 7 }] },
      '/deployments/7/statuses?per_page=100': {
        body: [{ state: 'in_progress' }],
        next: 'https://api.github.com/repositories/1/deployments/7/statuses?per_page=100&page=2',
      },
      '/repositories/1/deployments/7/statuses?per_page=100&page=2': { body: [{ state: 'success' }] },
    };
    const fetchImpl: typeof fetch = async (input) => {
      const path = String(input).replace('https://api.github.com/repos/acme/app', '').replace('https://api.github.com', '');
      const page = pages[path];
      if (!page) return new Response('{}', { status: 404 });
      const headers = page.next ? { link: `<${page.next}>; rel="next", <${page.next}>; rel="last"` } : undefined;
      return new Response(JSON.stringify(page.body), { status: 200, headers });
    };
    const github = createGitHubClient('acme/app', 'token', fetchImpl);
    expect((await github.checkRuns('aaa')).map((run) => run.name)).toEqual(['lint', 'test']);
    expect(await github.deployedTo('aaa', ['staging'])).toEqual(['staging']);
  });

  it('finds the newest deployment that succeeded, skipping one still running', async () => {
    const { fetch } = fakeFetch({
      '/deployments?environment=production&per_page=20': [
        { id: 3, sha: 'ccc' },
        { id: 2, sha: 'bbb' },
        { id: 1, sha: 'aaa' },
      ],
      '/deployments/3/statuses?per_page=100': [{ state: 'in_progress' }],
      '/deployments/2/statuses?per_page=100': [{ state: 'inactive' }, { state: 'success' }],
    });
    const github = createGitHubClient('acme/app', 'token', fetch);
    expect(await github.lastSuccessfulDeployment('production')).toBe('bbb');
  });

  it('returns nothing for an environment never deployed', async () => {
    const { fetch } = fakeFetch({ '/deployments?environment=production&per_page=20': [] });
    expect(await createGitHubClient('acme/app', 'token', fetch).lastSuccessfulDeployment('production')).toBeUndefined();
  });

  it('summarises the commits between two SHAs', async () => {
    const { fetch } = fakeFetch({
      '/compare/aaa...bbb?per_page=100': {
        status: 'ahead',
        total_commits: 1,
        html_url: 'https://github.com/acme/app/compare/aaa...bbb',
        commits: [
          {
            sha: 'bbb',
            html_url: 'https://github.com/acme/app/commit/bbb',
            commit: { message: 'fix: thing (#3)\n\nlong body', author: { name: 'Octo Cat' } },
            author: null,
          },
        ],
      },
    });
    expect(await createGitHubClient('acme/app', 'token', fetch).compare('aaa', 'bbb')).toEqual({
      totalCommits: 1,
      url: 'https://github.com/acme/app/compare/aaa...bbb',
      commits: [{ sha: 'bbb', message: 'fix: thing (#3)', author: 'Octo Cat', url: 'https://github.com/acme/app/commit/bbb' }],
    });
  });

  it('reads every page of a long comparison so the newest commits are included', async () => {
    const commit = (sha: string) => ({
      sha,
      html_url: `https://github.com/acme/app/commit/${sha}`,
      commit: { message: sha, author: { name: 'a' } },
      author: { login: 'a' },
    });
    const pages: Record<string, { body: unknown; next?: string }> = {
      '/repos/acme/app/compare/aaa...zzz?per_page=100': {
        body: { status: 'ahead', total_commits: 3, html_url: 'cmp', commits: [commit('c1'), commit('c2')] },
        next: 'https://api.github.com/repositories/1/compare/aaa...zzz?per_page=100&page=2',
      },
      '/repositories/1/compare/aaa...zzz?per_page=100&page=2': {
        body: { status: 'ahead', total_commits: 3, html_url: 'cmp', commits: [commit('c3')] },
      },
    };
    const fetchImpl: typeof fetch = async (input) => {
      const page = pages[String(input).replace('https://api.github.com', '')];
      if (!page) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(page.body), { headers: page.next ? { link: `<${page.next}>; rel="next"` } : undefined });
    };
    const result = await createGitHubClient('acme/app', 'token', fetchImpl).compare('aaa', 'zzz');
    expect(result.totalCommits).toBe(3);
    expect(result.commits.map((c) => c.sha)).toEqual(['c1', 'c2', 'c3']);
  });

  it('looks past the first page of deployments for the last success', async () => {
    const pages: Record<string, { body: unknown; next?: string }> = {
      '/repos/acme/app/deployments?environment=production&per_page=20': {
        body: [{ id: 9, sha: 'running' }],
        next: 'https://api.github.com/repositories/1/deployments?environment=production&per_page=20&page=2',
      },
      '/repos/acme/app/deployments/9/statuses?per_page=100': { body: [{ state: 'in_progress' }] },
      '/repositories/1/deployments?environment=production&per_page=20&page=2': { body: [{ id: 8, sha: 'good' }] },
      '/repos/acme/app/deployments/8/statuses?per_page=100': { body: [{ state: 'success' }] },
    };
    const fetchImpl: typeof fetch = async (input) => {
      const page = pages[String(input).replace('https://api.github.com', '')];
      if (!page) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(page.body), { headers: page.next ? { link: `<${page.next}>; rel="next"` } : undefined });
    };
    expect(await createGitHubClient('acme/app', 'token', fetchImpl).lastSuccessfulDeployment('production')).toBe('good');
  });

  it('starts a workflow on a branch with its inputs, with a User-Agent and token', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), init });
      return new Response(null, { status: 204 });
    };
    await createGitHubClient('acme/app', 'token', fetchImpl).dispatchWorkflow('ci.yml', 'main', { environment: 'staging' });
    expect(seen[0]?.url).toBe('https://api.github.com/repos/acme/app/actions/workflows/ci.yml/dispatches');
    expect(seen[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ ref: 'main', inputs: { environment: 'staging' } });
    const headers = new Headers(seen[0]?.init?.headers);
    expect(headers.get('user-agent')).toBe('ideasquared-ship');
    expect(headers.get('authorization')).toBe('Bearer token');
  });

  it('reads public data without a token', async () => {
    const seen: Headers[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      seen.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ default_branch: 'main' }));
    };
    expect(await createGitHubClient('acme/app', undefined, fetchImpl).defaultBranch()).toBe('main');
    expect(seen[0]?.has('authorization')).toBe(false);
  });

  it('decodes ship.yaml from the contents API and returns nothing for a missing file', async () => {
    const { fetch } = fakeFetch({
      '/contents/ship.yaml?ref=main': { content: Buffer.from('product: x\n').toString('base64'), encoding: 'base64' },
    });
    const github = createGitHubClient('acme/app', 'token', fetch);
    expect(await github.readFile('ship.yaml', 'main')).toBe('product: x\n');
    expect(await github.readFile('missing.yaml', 'main')).toBeUndefined();
  });

  it('finds the run a dispatch started, ignoring older runs', async () => {
    const run = (id: number, created_at: string) => ({ id, status: 'queued', conclusion: null, html_url: `u${id}`, created_at });
    const { fetch } = fakeFetch({
      '/actions/workflows/ci.yml/runs?event=workflow_dispatch&per_page=10': {
        workflow_runs: [run(2, '2026-11-13T21:00:05Z'), run(1, '2026-11-13T19:00:00Z')],
      },
    });
    const github = createGitHubClient('acme/app', 'token', fetch);
    expect((await github.findDispatchedRun('ci.yml', new Date('2026-11-13T21:00:00Z')))?.id).toBe(2);
    expect(await github.findDispatchedRun('ci.yml', new Date('2026-11-13T22:00:00Z'))).toBeUndefined();
  });

  it("includes GitHub's own message in errors", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403 });
    await expect(createGitHubClient('acme/app', undefined, fetchImpl).defaultBranch()).rejects.toThrow(
      'GitHub API / returned 403: API rate limit exceeded',
    );
  });

  it("reads GitHub's compare status between two commits", async () => {
    const { fetch } = fakeFetch({ '/compare/live...old?per_page=1': { status: 'behind' } });
    expect(await createGitHubClient('acme/app', 'token', fetch).relation('live', 'old')).toBe('behind');
  });

  it('records a Deployment of the exact commit, then its statuses', async () => {
    const seen: { url: string; body: unknown }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ id: 42, state: 'x' }), { status: 201 });
    };
    const github = createGitHubClient('acme/app', 'token', fetchImpl);
    const sha = 'abcdef1234567890abcdef1234567890abcdef12';
    expect(await github.createDeployment({ sha, environment: 'production', actor: 'octocat', production: true })).toBe(42);
    await github.setDeploymentStatus(42, { state: 'in_progress', logUrl: 'https://run/1' });
    await github.setDeploymentStatus(42, { state: 'success', logUrl: 'https://run/1', environmentUrl: 'https://app.dev' });
    expect(seen).toEqual([
      {
        url: 'https://api.github.com/repos/acme/app/deployments',
        body: {
          ref: sha,
          environment: 'production',
          auto_merge: false,
          required_contexts: [],
          transient_environment: false,
          production_environment: true,
          description: 'ship abcdef1 by octocat',
          payload: { actor: 'octocat' },
        },
      },
      { url: 'https://api.github.com/repos/acme/app/deployments/42/statuses', body: { state: 'in_progress', log_url: 'https://run/1' } },
      {
        url: 'https://api.github.com/repos/acme/app/deployments/42/statuses',
        body: { state: 'success', log_url: 'https://run/1', environment_url: 'https://app.dev' },
      },
    ]);
  });

  it('gives the HTTP status of a refused call, so a missing permission can be explained', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403 });
    const error = await createGitHubClient('acme/app', 'token', fetchImpl)
      .createDeployment({ sha: 'aaa', environment: 'staging', actor: 'o', production: false })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ status: 403, message: 'GitHub API /deployments returned 403: Resource not accessible by integration' });
  });
});
