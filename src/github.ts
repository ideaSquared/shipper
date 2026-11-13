import { z } from 'zod';
import type { CheckRun } from './gate.ts';
import type { Comparison } from './notify.ts';

export type GitHubClient = {
  isOnBranch(sha: string, branch: string): Promise<boolean>;
  checkRuns(sha: string): Promise<CheckRun[]>;
  deployedTo(sha: string, environments: readonly string[]): Promise<string[]>;
  // SHA of the newest deployment to the environment that reached success, if any.
  lastSuccessfulDeployment(environment: string): Promise<string | undefined>;
  compare(base: string, head: string): Promise<Comparison>;
};

const CompareSchema = z.object({
  status: z.string(),
  total_commits: z.number().default(0),
  html_url: z.string().default(''),
  commits: z
    .array(
      z.object({
        sha: z.string(),
        html_url: z.string(),
        commit: z.object({ message: z.string(), author: z.object({ name: z.string() }).nullable() }),
        author: z.object({ login: z.string() }).nullable(),
      }),
    )
    .default([]),
});
const DeploymentShasSchema = z.array(z.object({ id: z.number(), sha: z.string() }));
const CheckRunsSchema = z.object({
  check_runs: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })),
});
const DeploymentsSchema = z.array(z.object({ id: z.number() }));
const StatusesSchema = z.array(z.object({ state: z.string() }));

const BASE = 'https://api.github.com';

export function createGitHubClient(repository: string, token: string, fetchImpl: typeof fetch = fetch): GitHubClient {
  async function request(url: string): Promise<Response> {
    const response = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!response.ok) throw new Error(`GitHub API ${url.replace(`${BASE}/repos/${repository}`, '')} returned ${response.status}`);
    return response;
  }

  async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await request(`${BASE}/repos/${repository}${path}`);
    return schema.parse(await response.json());
  }

  // Follows the Link header's rel="next" until the last page.
  async function getAll<T, Item>(path: string, schema: z.ZodType<T>, items: (page: T) => Item[]): Promise<Item[]> {
    const fetchFrom = async (url: string): Promise<Item[]> => {
      const response = await request(url);
      const page = items(schema.parse(await response.json()));
      const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1];
      return next ? [...page, ...(await fetchFrom(next))] : page;
    };
    return fetchFrom(`${BASE}/repos/${repository}${path}`);
  }

  async function hasSuccessfulDeployment(sha: string, environment: string): Promise<boolean> {
    const query = new URLSearchParams({ sha, environment, per_page: '100' });
    const deployments = await getAll(`/deployments?${query}`, DeploymentsSchema, (page) => page);
    const statuses = await Promise.all(
      deployments.map((deployment) =>
        getAll(`/deployments/${deployment.id}/statuses?per_page=100`, StatusesSchema, (page) => page),
      ),
    );
    return statuses.flat().some((status) => status.state === 'success');
  }

  return {
    async isOnBranch(sha, branch) {
      // "behind" or "identical" means the SHA is contained in the branch.
      const { status } = await get(`/compare/${encodeURIComponent(branch)}...${sha}`, CompareSchema);
      return status === 'behind' || status === 'identical';
    },
    async checkRuns(sha) {
      // GitHub's default filter returns the latest run of each check, so a passing re-run replaces a failure.
      return getAll(`/commits/${sha}/check-runs?per_page=100`, CheckRunsSchema, (page) => page.check_runs);
    },
    async lastSuccessfulDeployment(environment) {
      const query = new URLSearchParams({ environment, per_page: '20' });
      const deployments = await get(`/deployments?${query}`, DeploymentShasSchema);
      // Newest first; stop at the first one that succeeded.
      return deployments.reduce<Promise<string | undefined>>(async (found, deployment) => {
        const sha = await found;
        if (sha) return sha;
        const statuses = await getAll(`/deployments/${deployment.id}/statuses?per_page=100`, StatusesSchema, (page) => page);
        return statuses.some((status) => status.state === 'success') ? deployment.sha : undefined;
      }, Promise.resolve(undefined));
    },
    async compare(base, head) {
      const result = await get(`/compare/${base}...${head}`, CompareSchema);
      return {
        totalCommits: result.total_commits,
        url: result.html_url,
        commits: result.commits.map((commit) => ({
          sha: commit.sha,
          message: commit.commit.message.split('\n')[0] ?? '',
          author: commit.author?.login ?? commit.commit.author?.name ?? 'unknown',
          url: commit.html_url,
        })),
      };
    },
    async deployedTo(sha, environments) {
      const results = await Promise.all(environments.map((env) => hasSuccessfulDeployment(sha, env)));
      return environments.filter((_, index) => results[index]);
    },
  };
}
