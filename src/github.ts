import { z } from 'zod';
import type { CheckRun } from './gate.ts';

export type GitHubClient = {
  isOnBranch(sha: string, branch: string): Promise<boolean>;
  checkRuns(sha: string): Promise<CheckRun[]>;
  deployedTo(sha: string, environments: readonly string[]): Promise<string[]>;
};

const CompareSchema = z.object({ status: z.string() });
const CheckRunsSchema = z.object({
  check_runs: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })),
});
const DeploymentsSchema = z.array(z.object({ id: z.number() }));
const StatusesSchema = z.array(z.object({ state: z.string() }));

export function createGitHubClient(repository: string, token: string, fetchImpl: typeof fetch = fetch): GitHubClient {
  async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!response.ok) throw new Error(`GitHub API ${path} returned ${response.status}`);
    return schema.parse(await response.json());
  }

  async function hasSuccessfulDeployment(sha: string, environment: string): Promise<boolean> {
    const query = new URLSearchParams({ sha, environment, per_page: '100' });
    const deployments = await get(`/deployments?${query}`, DeploymentsSchema);
    const statuses = await Promise.all(
      deployments.map((deployment) => get(`/deployments/${deployment.id}/statuses?per_page=100`, StatusesSchema)),
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
      const { check_runs } = await get(`/commits/${sha}/check-runs?per_page=100`, CheckRunsSchema);
      return check_runs;
    },
    async deployedTo(sha, environments) {
      const results = await Promise.all(environments.map((env) => hasSuccessfulDeployment(sha, env)));
      return environments.filter((_, index) => results[index]);
    },
  };
}
