import { z } from 'zod';
// A GitHub API call that did not succeed, with its HTTP status so callers can explain 403s and 404s.
export class GitHubApiError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.name = 'GitHubApiError';
        this.status = status;
    }
}
const CompareSchema = z.object({
    status: z.string(),
    total_commits: z.number().default(0),
    html_url: z.string().default(''),
    commits: z
        .array(z.object({
        sha: z.string(),
        html_url: z.string(),
        commit: z.object({ message: z.string(), author: z.object({ name: z.string() }).nullable() }),
        author: z.object({ login: z.string() }).nullable(),
    }))
        .default([]),
});
const DeploymentShasSchema = z.array(z.object({ id: z.number(), sha: z.string() }));
const CheckRunsSchema = z.object({
    check_runs: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })),
});
const DeploymentsSchema = z.array(z.object({ id: z.number() }));
const StatusesSchema = z.array(z.object({ state: z.string() }));
const RepoSchema = z.object({ default_branch: z.string() });
const CommitSchema = z.object({ sha: z.string() });
const ContentSchema = z.object({ content: z.string(), encoding: z.string() });
const DeploymentListSchema = z.array(z.object({ id: z.number(), sha: z.string(), created_at: z.string(), creator: z.object({ login: z.string() }).nullable() }));
const RunSchema = z.object({
    id: z.number(),
    status: z.string(),
    conclusion: z.string().nullable(),
    html_url: z.string(),
    created_at: z.string(),
});
const RunsSchema = z.object({ workflow_runs: z.array(RunSchema) });
const CreatedSchema = z.object({ id: z.number() });
const JobsSchema = z.object({
    jobs: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })),
});
const toRun = (run) => ({
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url,
    createdAt: run.created_at,
});
const BASE = 'https://api.github.com';
// Without a token, only public repositories can be read, and nothing can be dispatched.
export function createGitHubClient(repository, token, fetchImpl = fetch) {
    async function request(url, init = {}) {
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
        if (!response.ok) {
            const detail = await response
                .json()
                .then((body) => (typeof body === 'object' && body && 'message' in body ? `: ${String(body.message)}` : ''))
                .catch(() => '');
            const path = url.replace(`${BASE}/repos/${repository}`, '') || '/';
            throw new GitHubApiError(`GitHub API ${path} returned ${response.status}${detail}`, response.status);
        }
        return response;
    }
    async function get(path, schema) {
        const response = await request(`${BASE}/repos/${repository}${path}`);
        return schema.parse(await response.json());
    }
    // Follows the Link header's rel="next" until the last page.
    async function getAll(path, schema, items) {
        const fetchFrom = async (url) => {
            const response = await request(url);
            const page = items(schema.parse(await response.json()));
            const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1];
            return next ? [...page, ...(await fetchFrom(next))] : page;
        };
        return fetchFrom(`${BASE}/repos/${repository}${path}`);
    }
    // Walks pages (rel="next") only until `pick` finds something, so a long history costs nothing extra.
    async function findInPages(path, schema, items, pick) {
        const fromPage = async (url) => {
            const response = await request(url);
            const found = await items(schema.parse(await response.json())).reduce(async (earlier, item) => (await earlier) ?? pick(item), Promise.resolve(undefined));
            if (found !== undefined)
                return found;
            const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1];
            return next ? fromPage(next) : undefined;
        };
        return fromPage(`${BASE}/repos/${repository}${path}`);
    }
    async function hasSuccessfulDeployment(sha, environment) {
        const query = new URLSearchParams({ sha, environment, per_page: '100' });
        const deployments = await getAll(`/deployments?${query}`, DeploymentsSchema, (page) => page);
        const statuses = await Promise.all(deployments.map((deployment) => getAll(`/deployments/${deployment.id}/statuses?per_page=100`, StatusesSchema, (page) => page)));
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
            // Newest first; stop at the first one that succeeded.
            return findInPages(`/deployments?${query}`, DeploymentShasSchema, (page) => page, async (deployment) => {
                const statuses = await getAll(`/deployments/${deployment.id}/statuses?per_page=100`, StatusesSchema, (page) => page);
                return statuses.some((status) => status.state === 'success') ? deployment.sha : undefined;
            });
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
            if (response.status === 404)
                return undefined;
            if (!response.ok)
                throw new Error(`GitHub API /contents/${path} returned ${response.status}`);
            const file = ContentSchema.parse(await response.json());
            return Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
        },
        async deployments(environment, limit) {
            const query = new URLSearchParams({ environment, per_page: String(limit) });
            const list = await get(`/deployments?${query}`, DeploymentListSchema);
            return Promise.all(list.map(async (deployment) => {
                const [latest] = await get(`/deployments/${deployment.id}/statuses?per_page=1`, StatusesSchema);
                return {
                    sha: deployment.sha,
                    createdAt: deployment.created_at,
                    creator: deployment.creator?.login ?? 'unknown',
                    state: latest?.state ?? 'pending',
                };
            }));
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
        async deployedTo(sha, environments) {
            const results = await Promise.all(environments.map((env) => hasSuccessfulDeployment(sha, env)));
            return environments.filter((_, index) => results[index]);
        },
    };
}
