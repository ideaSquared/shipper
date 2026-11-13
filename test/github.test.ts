import { describe, expect, it } from 'vitest';
import { createGitHubClient } from '../src/github.ts';

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
});
