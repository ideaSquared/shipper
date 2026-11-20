import { describe, expect, it } from 'vitest';
import { doctor } from '../src/doctor.ts';
import { GitHubApiError, type GitHubClient } from '../src/github.ts';

const MANIFEST = `
product: app
checks: [test]
environments:
  staging: {}
  production: { requires: [staging] }
dispatch:
  workflow: ci.yml
components:
  web:
    type: cloudflare-worker
    health:
      staging: https://staging.example.com/health
      production: https://example.com/health
`;

const FILES: Record<string, string> = {
  'ship.yaml': MANIFEST,
  '.github/workflows/ci.yml': 'on: workflow_dispatch',
  '.github/workflows/ship-rollback.yml': 'on: workflow_dispatch',
  '.github/CODEOWNERS': '* @acme/team\n',
};

function client(overrides: Partial<GitHubClient> = {}, files: Record<string, string> = FILES): GitHubClient {
  const unused = async (): Promise<never> => {
    throw new Error('not used by doctor');
  };
  return {
    isOnBranch: unused,
    deployedTo: unused,
    lastSuccessfulDeployment: unused,
    compare: unused,
    relation: unused,
    deployments: unused,
    dispatchWorkflow: unused,
    findDispatchedRun: unused,
    run: unused,
    jobs: unused,
    createDeployment: unused,
    setDeploymentStatus: unused,
    defaultBranch: async () => 'main',
    headSha: async () => 'abcdef1234567',
    readFile: async (path) => files[path],
    checkRuns: async () => [{ name: 'test', status: 'completed', conclusion: 'success' }],
    environments: async () => [
      { name: 'staging', requiredReviewers: false },
      { name: 'production', requiredReviewers: true },
    ],
    ...overrides,
  };
}

const without = (files: Record<string, string>, path: string) => Object.fromEntries(Object.entries(files).filter(([key]) => key !== path));

const reachable: typeof fetch = async () => new Response('nope', { status: 503 });

async function run(github: GitHubClient, options: { environment?: string; fetch?: typeof fetch; healthTimeoutMs?: number } = {}) {
  const lines: string[] = [];
  const code = await doctor(github, 'acme/app', { print: (line) => lines.push(line), fetch: reachable, ...options });
  return { code, text: lines.join('\n') };
}

describe('doctor', () => {
  it('passes a correctly set up product, counting any HTTP status as reachable', async () => {
    const { code, text } = await run(client());
    expect(code).toBe(0);
    expect(text).not.toMatch(/❌|⚠️/);
    expect(text).toContain('staging health https://staging.example.com/health answers (503)');
  });

  it('fails when ship.yaml is missing or invalid', async () => {
    const missing = await run(client({}, {}));
    expect(missing.code).toBe(1);
    expect(missing.text).toContain('❌ ship.yaml not found on main');
    const invalid = await run(client({}, { 'ship.yaml': 'product: Bad Name' }));
    expect(invalid.code).toBe(1);
    expect(invalid.text).toContain('ship.yaml is invalid');
  });

  it('fails when the dispatch or rollback workflow file does not exist', async () => {
    const { code, text } = await run(client({}, without(FILES, '.github/workflows/ship-rollback.yml')));
    expect(code).toBe(1);
    expect(text).toContain('❌ rollback workflow ship-rollback.yml not found on main');
    expect(text).toContain('✅ dispatch workflow ci.yml exists');
  });

  it('fails for a missing GitHub Environment, with a fix hint', async () => {
    const { code, text } = await run(client({ environments: async () => [{ name: 'production', requiredReviewers: true }] }));
    expect(code).toBe(1);
    expect(text).toContain("❌ GitHub Environment 'staging' does not exist");
    expect(text).toContain('fix: Create it in Settings → Environments');
  });

  it('warns, without failing, when production has no required reviewers', async () => {
    const { code, text } = await run(client({ environments: async () => [{ name: 'staging', requiredReviewers: false }, { name: 'production', requiredReviewers: false }] }));
    expect(code).toBe(0);
    expect(text).toContain("'production' has no required reviewers");
    expect(text).toContain('Add required reviewers in Settings → Environments → production');
  });

  it('wants reviewers on an environment with requires, not on a plain one', async () => {
    const manifest = MANIFEST.replace('production: { requires: [staging] }', 'production: {}\n  qa: { requires: [staging] }');
    const { text } = await run(
      client(
        { environments: async () => ['staging', 'production', 'qa'].map((name) => ({ name, requiredReviewers: name === 'production' })) },
        { ...FILES, 'ship.yaml': manifest },
      ),
    );
    expect(text).toContain("'qa' has no required reviewers");
    expect(text).not.toContain("'staging' has no required reviewers");
  });

  it("warns instead of crashing when environments can't be read", async () => {
    const { code, text } = await run(client({ environments: async () => Promise.reject(new GitHubApiError('nope', 403)) }));
    expect(code).toBe(0);
    expect(text).toContain("⚠️  can't read environments: needs admin access");
  });

  it('warns when CODEOWNERS has no * line, and finds it in the other locations', async () => {
    const without = await run(client({}, { ...FILES, '.github/CODEOWNERS': '/docs @acme/docs\n' }));
    expect(without.code).toBe(0);
    expect(without.text).toContain("CODEOWNERS has no '*' line");
    const elsewhere = await run(client({}, { ...without(FILES, '.github/CODEOWNERS'), 'docs/CODEOWNERS': '* @acme/team' }));
    expect(elsewhere.text).toContain("✅ CODEOWNERS has a '*' line (@acme/team)");
  });

  it('fails when a required check name never ran on the default branch head', async () => {
    const { code, text } = await run(client({ checkRuns: async () => [{ name: 'tests', status: 'completed', conclusion: 'success' }] }));
    expect(code).toBe(1);
    expect(text).toContain("❌ check 'test' not found on abcdef1");
    expect(text).toContain('seen: tests');
  });

  it('fails a health URL on a DNS failure, a TLS error or a timeout, naming the cause', async () => {
    const failing = (error: Error): typeof fetch => async () => {
      throw error;
    };
    const dns = await run(client(), { fetch: failing(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) })) });
    expect(dns.code).toBe(1);
    expect(dns.text).toContain('domain does not resolve');
    const tls = await run(client(), { fetch: failing(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'CERT_HAS_EXPIRED' }) })) });
    expect(tls.text).toContain('bad TLS certificate');
    const timeout = await run(client(), { fetch: failing(new DOMException('The operation timed out', 'TimeoutError')), healthTimeoutMs: 10_000 });
    expect(timeout.text).toContain('timed out after 10s');
  });

  it('only fetches absolute https health URLs, once each, and never prints the query', async () => {
    const manifest = MANIFEST.replace(
      /health:[\s\S]*$/,
      'health:\n      staging: /health\n      production: { url: "http://example.com/health" }\n',
    );
    const none = await run(client({}, { ...FILES, 'ship.yaml': manifest }), {
      fetch: async () => {
        throw new Error('should not be called');
      },
    });
    expect(none.code).toBe(0);
    const urls: string[] = [];
    const twice = MANIFEST.replace('https://staging.example.com/health', 'https://example.com/health?token=secret');
    const { text } = await run(client({}, { ...FILES, 'ship.yaml': twice }), {
      fetch: async (input) => {
        urls.push(String(input));
        return new Response('ok');
      },
    });
    expect(urls).toEqual(['https://example.com/health?token=secret', 'https://example.com/health']);
    expect(text).not.toContain('secret');
  });

  it('with an environment, checks only that environment but still the repo-wide things', async () => {
    const urls: string[] = [];
    const { text } = await run(client({ environments: async () => [{ name: 'staging', requiredReviewers: false }] }), {
      environment: 'staging',
      fetch: async (input) => {
        urls.push(String(input));
        return new Response('ok');
      },
    });
    expect(urls).toEqual(['https://staging.example.com/health']);
    expect(text).not.toContain("'production'");
    expect(text).toContain('dispatch workflow ci.yml exists');
  });

  it('fails for an environment ship.yaml does not define', async () => {
    const { code, text } = await run(client(), { environment: 'qa' });
    expect(code).toBe(1);
    expect(text).toContain("environment 'qa' is not in ship.yaml");
  });
});
