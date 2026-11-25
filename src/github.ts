import { z } from 'zod';
import type { CheckRun } from './gate.ts';
import type { Comparison } from './notify.ts';

export type GitHubClient = {
  isOnBranch(sha: string, branch: string): Promise<boolean>;
  checkRuns(sha: string): Promise<CheckRun[]>;
  deployedTo(sha: string, environments: readonly string[]): Promise<string[]>;
  // Environments a deploy of `sha` is under way in: its newest deployment there has not finished yet.
  deployingTo(sha: string, environments: readonly string[]): Promise<string[]>;
  // SHA of the newest live deployment to the environment, if any: one that reached `success`, or whose latest
  // status is `error` (it went live but failed its smoke checks, and is still running).
  lastLiveDeployment(environment: string): Promise<string | undefined>;
  compare(base: string, head: string): Promise<Comparison>;
  // GitHub's compare status of base...head: "ahead", "behind", "identical" or "diverged".
  relation(base: string, head: string): Promise<string>;
  defaultBranch(): Promise<string>;
  headSha(branch: string): Promise<string>;
  readFile(path: string, ref: string): Promise<string | undefined>;
  // Newest first, each with its latest status.
  deployments(environment: string, limit: number): Promise<DeploymentSummary[]>;
  dispatchWorkflow(workflow: string, ref: string, inputs: Record<string, string>): Promise<void>;
  // The newest workflow_dispatch run of the workflow created at or after `since`, if it exists yet.
  findDispatchedRun(workflow: string, since: Date): Promise<RunSummary | undefined>;
  run(id: number): Promise<RunSummary>;
  jobs(runId: number): Promise<JobSummary[]>;
  // Records a Deployment of `sha` to the environment and returns its id.
  createDeployment(deployment: NewDeployment): Promise<number>;
  setDeploymentStatus(id: number, status: NewDeploymentStatus): Promise<void>;
  // An Actions repository variable's value; undefined when it is not set (GitHub answers 404).
  readVariable(name: string): Promise<string | undefined>;
  // Creates the variable, or updates it when it exists.
  writeVariable(name: string, value: string): Promise<void>;
  // Deletes the variable; one that is already gone is fine.
  deleteVariable(name: string): Promise<void>;
  // The GitHub login the token belongs to.
  currentUser(): Promise<string>;
  // The repo's GitHub Environments. Needs admin access to read.
  environments(): Promise<EnvironmentSummary[]>;
  // Names (never values) of the secrets a deploy to the environment can use: repository, environment and
  // organization secrets. Needs admin access to read.
  secretNames(environment: string): Promise<string[]>;
};

export type EnvironmentSummary = { name: string; requiredReviewers: boolean };

export type NewDeployment = { sha: string; environment: string; actor: string; production: boolean };
export type NewDeploymentStatus = {
  // `error`: deployed and live, but its smoke checks failed (see main.ts); `failure`: not live.
  state: 'in_progress' | 'success' | 'failure' | 'error';
  logUrl?: string;
  environmentUrl?: string;
  description?: string;
};

// A GitHub API call that did not succeed, with its HTTP status so callers can explain 403s and 404s.
export class GitHubApiError extends Error {
  readonly status: number;
  /** GitHub refused because the API rate limit is used up, not because of access. */
  readonly rateLimited: boolean;
  constructor(message: string, status: number, rateLimited = false) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.rateLimited = rateLimited;
  }
}

// GitHub answers a spent rate limit with 403 (or 429), so the status alone can't tell it from no access.
async function apiError(response: Response, path: string): Promise<GitHubApiError> {
  const message = await response
    .json()
    .then((body: unknown) => (typeof body === 'object' && body && 'message' in body ? String(body.message) : ''))
    .catch(() => '');
  const rateLimited =
    (response.status === 403 || response.status === 429) && (response.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(message));
  return new GitHubApiError(`GitHub API ${path} returned ${response.status}${message ? `: ${message}` : ''}`, response.status, rateLimited);
}

/** A 403/404 that means the caller can't see the repo (a spent rate limit is not one). */
export function isAccessError(error: unknown): error is GitHubApiError {
  return error instanceof GitHubApiError && (error.status === 403 || error.status === 404) && !error.rateLimited;
}

export type DeploymentSummary = { sha: string; createdAt: string; creator: string; state: string };
export type RunSummary = { id: number; status: string; conclusion: string | null; url: string; createdAt: string };
export type StepSummary = { name: string; status: string; conclusion: string | null };
export type JobSummary = { name: string; status: string; conclusion: string | null; steps?: StepSummary[] };

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
  files: z.array(z.object({ filename: z.string(), status: z.string(), previous_filename: z.string().optional() })).default([]),
});
const DeploymentShasSchema = z.array(z.object({ id: z.number(), sha: z.string() }));
const CheckRunsSchema = z.object({
  check_runs: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })),
});
const DeploymentsSchema = z.array(z.object({ id: z.number() }));
const StatusesSchema = z.array(z.object({ state: z.string() }));
const DatedDeploymentsSchema = z.array(z.object({ id: z.number(), created_at: z.string() }));
const DatedStatusesSchema = z.array(z.object({ state: z.string(), created_at: z.string() }));
// Deployment states that mean a deploy has started and not finished. No status at all is `pending` too.
const UNFINISHED = new Set(['pending', 'queued', 'waiting', 'in_progress']);
// A cancelled, timed-out or lost deploy job never finishes its Deployment, so an unfinished one older than
// this is abandoned, not under way. Above the deploy job's `timeout-minutes` (60) in deploy.yml.
const ABANDONED_AFTER_MS = 90 * 60_000;

const RepoSchema = z.object({ default_branch: z.string() });
const CommitSchema = z.object({ sha: z.string() });
const ContentSchema = z.object({ content: z.string(), encoding: z.string() });
const DeploymentListSchema = z.array(
  z.object({ id: z.number(), sha: z.string(), created_at: z.string(), creator: z.object({ login: z.string() }).nullable() }),
);
const RunSchema = z.object({
  id: z.number(),
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.string(),
  created_at: z.string(),
});
const RunsSchema = z.object({ workflow_runs: z.array(RunSchema) });
const CreatedSchema = z.object({ id: z.number() });
const VariableSchema = z.object({ value: z.string() });
const UserSchema = z.object({ login: z.string() });
const JobsSchema = z.object({
  jobs: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      steps: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })).optional(),
    }),
  ),
});

const EnvironmentsSchema = z.object({
  environments: z.array(z.object({ name: z.string(), protection_rules: z.array(z.object({ type: z.string() })).default([]) })),
});

const SecretsSchema = z.object({ secrets: z.array(z.object({ name: z.string() })) });

const toRun = (run: z.infer<typeof RunSchema>): RunSummary => ({
  id: run.id,
  status: run.status,
  conclusion: run.conclusion,
  url: run.html_url,
  createdAt: run.created_at,
});

const BASE = 'https://api.github.com';

// Without a token, only public repositories can be read, and nothing can be dispatched.
export function createGitHubClient(repository: string, token: string | undefined, fetchImpl: typeof fetch = fetch): GitHubClient {
  async function request(url: string, init: { method?: string; body?: string } = {}): Promise<Response> {
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        // GitHub refuses API requests without a User-Agent.
        'user-agent': 'ideasquared-ship',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    if (!response.ok) throw await apiError(response, url.replace(`${BASE}/repos/${repository}`, '') || '/');
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

  // Walks pages (rel="next") only until `pick` finds something, so a long history costs nothing extra.
  async function findInPages<T, Item, Found>(
    path: string,
    schema: z.ZodType<T>,
    items: (page: T) => Item[],
    pick: (item: Item) => Promise<Found | undefined>,
  ): Promise<Found | undefined> {
    const fromPage = async (url: string): Promise<Found | undefined> => {
      const response = await request(url);
      const found = await items(schema.parse(await response.json())).reduce<Promise<Found | undefined>>(
        async (earlier, item) => (await earlier) ?? pick(item),
        Promise.resolve(undefined),
      );
      if (found !== undefined) return found;
      const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1];
      return next ? fromPage(next) : undefined;
    };
    return fromPage(`${BASE}/repos/${repository}${path}`);
  }

  async function hasSuccessfulDeployment(sha: string, environment: string): Promise<boolean> {
    const query = new URLSearchParams({ sha, environment, per_page: '100' });
    const deployments = await getAll(`/deployments?${query}`, DeploymentsSchema, (page) => page);
    const statuses = await Promise.all(
      deployments.map((deployment) => getAll(`/deployments/${deployment.id}/statuses?per_page=100`, StatusesSchema, (page) => page)),
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
    async lastLiveDeployment(environment) {
      const query = new URLSearchParams({ environment, per_page: '20' });
      // Newest first; stop at the first one that is live. Statuses are newest first too. Shipper writes `error`
      // only for a smoke failure, so a newer `failure` or a deploy still running doesn't hide it.
      return findInPages(
        `/deployments?${query}`,
        DeploymentShasSchema,
        (page) => page,
        async (deployment) => {
          const statuses = await getAll(`/deployments/${deployment.id}/statuses?per_page=100`, StatusesSchema, (page) => page);
          const live = statuses[0]?.state === 'error' || statuses.some((status) => status.state === 'success');
          return live ? deployment.sha : undefined;
        },
      );
    },
    async relation(base, head) {
      return (await get(`/compare/${base}...${head}?per_page=1`, CompareSchema)).status;
    },
    async compare(base, head) {
      // Every page, so the newest commits are really the newest (one unpaged compare stops at 250).
      const pages = await getAll(`/compare/${base}...${head}?per_page=100`, CompareSchema, (page) => [page]);
      const commits = pages.flatMap((page) => page.commits);
      return {
        totalCommits: pages[0]?.total_commits ?? commits.length,
        url: pages[0]?.html_url ?? '',
        // GitHub lists up to 300 files, the same on every page, so the first page has them all.
        files: (pages[0]?.files ?? []).map(({ filename, status, previous_filename }) => ({
          filename,
          status,
          ...(previous_filename ? { previousFilename: previous_filename } : {}),
        })),
        commits: commits.map((commit) => ({
          sha: commit.sha,
          message: commit.commit.message.split('\n')[0] ?? '',
          author: commit.author?.login ?? commit.commit.author?.name ?? 'unknown',
          url: commit.html_url,
        })),
      };
    },
    async defaultBranch() {
      return (await get('', RepoSchema)).default_branch;
    },
    async headSha(branch) {
      return (await get(`/commits/${encodeURIComponent(branch)}`, CommitSchema)).sha;
    },
    async readFile(path, ref) {
      const response = await fetchImpl(`${BASE}/repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`, {
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          // GitHub refuses API requests without a User-Agent.
          'user-agent': 'ideasquared-ship',
        },
      });
      if (response.status === 404) return undefined;
      if (!response.ok) throw await apiError(response, `/contents/${path}`);
      const file = ContentSchema.parse(await response.json());
      return Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
    },
    async deployments(environment, limit) {
      const query = new URLSearchParams({ environment, per_page: String(limit) });
      const list = await get(`/deployments?${query}`, DeploymentListSchema);
      return Promise.all(
        list.map(async (deployment) => {
          const [latest] = await get(`/deployments/${deployment.id}/statuses?per_page=1`, StatusesSchema);
          return {
            sha: deployment.sha,
            createdAt: deployment.created_at,
            creator: deployment.creator?.login ?? 'unknown',
            state: latest?.state ?? 'pending',
          };
        }),
      );
    },
    async dispatchWorkflow(workflow, ref, inputs) {
      await request(`${BASE}/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
        method: 'POST',
        body: JSON.stringify({ ref, inputs }),
      });
    },
    async findDispatchedRun(workflow, since) {
      const query = new URLSearchParams({ event: 'workflow_dispatch', per_page: '10' });
      const { workflow_runs } = await get(`/actions/workflows/${encodeURIComponent(workflow)}/runs?${query}`, RunsSchema);
      // Allow for clock skew between this machine and GitHub.
      const after = since.getTime() - 30_000;
      const run = workflow_runs.find((candidate) => Date.parse(candidate.created_at) >= after);
      return run ? toRun(run) : undefined;
    },
    async run(id) {
      return toRun(await get(`/actions/runs/${id}`, RunSchema));
    },
    async jobs(runId) {
      return getAll(`/actions/runs/${runId}/jobs?per_page=100`, JobsSchema, (page) => page.jobs);
    },
    async createDeployment({ sha, environment, actor, production }) {
      const response = await request(`${BASE}/repos/${repository}/deployments`, {
        method: 'POST',
        body: JSON.stringify({
          ref: sha,
          environment,
          // The gate has already checked the commit; GitHub must not merge or wait on checks itself.
          auto_merge: false,
          required_contexts: [],
          transient_environment: false,
          production_environment: production,
          description: `ship ${sha.slice(0, 7)} by ${actor}`,
          payload: { actor },
        }),
      });
      return CreatedSchema.parse(await response.json()).id;
    },
    async setDeploymentStatus(id, { state, logUrl, environmentUrl, description }) {
      const response = await request(`${BASE}/repos/${repository}/deployments/${id}/statuses`, {
        method: 'POST',
        body: JSON.stringify({
          state,
          ...(logUrl ? { log_url: logUrl } : {}),
          ...(environmentUrl ? { environment_url: environmentUrl } : {}),
          ...(description ? { description } : {}),
        }),
      });
      CreatedSchema.parse(await response.json());
    },
    async readVariable(name) {
      return get(`/actions/variables/${encodeURIComponent(name)}`, VariableSchema).then(
        ({ value }) => value,
        (error: unknown) => {
          if (error instanceof GitHubApiError && error.status === 404) return undefined;
          throw error;
        },
      );
    },
    async writeVariable(name, value) {
      const base = `${BASE}/repos/${repository}/actions/variables`;
      await request(`${base}/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify({ name, value }) }).catch(async (error: unknown) => {
        if (!(error instanceof GitHubApiError && error.status === 404)) throw error;
        await request(base, { method: 'POST', body: JSON.stringify({ name, value }) });
      });
    },
    async deleteVariable(name) {
      await request(`${BASE}/repos/${repository}/actions/variables/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch((error: unknown) => {
        if (!(error instanceof GitHubApiError && error.status === 404)) throw error;
      });
    },
    async currentUser() {
      const response = await request(`${BASE}/user`);
      return UserSchema.parse(await response.json()).login;
    },
    async environments() {
      return getAll('/environments?per_page=100', EnvironmentsSchema, (page) =>
        page.environments.map((environment) => ({
          name: environment.name,
          requiredReviewers: environment.protection_rules.some((rule) => rule.type === 'required_reviewers'),
        })),
      );
    },
    async secretNames(environment) {
      const names = (path: string) => getAll(path, SecretsSchema, (page) => page.secrets.map((secret) => secret.name));
      const lists = await Promise.all([
        names('/actions/secrets?per_page=100'),
        names(`/environments/${encodeURIComponent(environment)}/secrets?per_page=100`),
        names('/actions/organization-secrets?per_page=100'),
      ]);
      return [...new Set(lists.flat())];
    },
    async deployedTo(sha, environments) {
      const results = await Promise.all(environments.map((env) => hasSuccessfulDeployment(sha, env)));
      return environments.filter((_, index) => results[index]);
    },
    async deployingTo(sha, environments) {
      const results = await Promise.all(
        environments.map(async (environment) => {
          // Newest first, so one deployment and its latest status are enough.
          const [newest] = await get(`/deployments?${new URLSearchParams({ sha, environment, per_page: '1' })}`, DatedDeploymentsSchema);
          if (!newest) return false;
          const [latest] = await get(`/deployments/${newest.id}/statuses?per_page=1`, DatedStatusesSchema);
          if (!UNFINISHED.has(latest?.state ?? 'pending')) return false;
          return Date.now() - Date.parse((latest ?? newest).created_at) < ABANDONED_AFTER_MS;
        }),
      );
      return environments.filter((_, index) => results[index]);
    },
  };
}
