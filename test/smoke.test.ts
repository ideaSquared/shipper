import { describe, expect, it } from 'vitest';
import { parseManifest } from '../src/manifest.ts';
import { runSmoke, smokeAfterDeploy, smokeComponent } from '../src/smoke.ts';

const MANIFEST = `
product: creatrgrid
environments: { staging: {}, production: {} }
smoke:
  staging:
    - https://staging.example.com/
    - { url: https://api-staging.example.com/demo, expect: '"slug":"demo"' }
components:
  api: { type: cloudflare-worker }
`;
const manifest = parseManifest(MANIFEST);
const noSleep = async () => {};

function fakeFetch(handler: (url: string) => Response): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (input) => {
      const url = String(input);
      urls.push(url);
      return handler(url);
    },
  };
}

describe('smoke manifest', () => {
  it('rejects an environment that is not defined', () => {
    expect(() => parseManifest(MANIFEST.replace('  staging:\n    - https', '  qa:\n    - https'))).toThrow(/smoke\.qa: unknown environment 'qa'/);
  });

  it('rejects a check that is not a full https URL', () => {
    expect(() => parseManifest(MANIFEST.replace('https://staging.example.com/', '/health'))).toThrow(/full https URL/);
  });
});

describe('runSmoke', () => {
  it('passes when every URL answers and expected text is present', async () => {
    const { fetch: f, urls } = fakeFetch((url) => new Response(url.includes('api') ? '{"slug":"demo"}' : 'ok'));
    const results = await runSmoke(manifest, 'staging', { fetch: f, sleep: noSleep });
    expect(results.every((r) => r.ok)).toBe(true);
    expect(urls).toEqual(['https://staging.example.com/', 'https://api-staging.example.com/demo']);
  });

  it('runs nothing for an environment without smoke checks', async () => {
    const { fetch: f, urls } = fakeFetch(() => new Response('ok'));
    expect(await runSmoke(manifest, 'production', { fetch: f, sleep: noSleep })).toEqual([]);
    expect(urls).toEqual([]);
  });

  it('retries a flaky URL and then passes', async () => {
    let calls = 0;
    const f: typeof fetch = async () => new Response('ok', { status: ++calls < 3 ? 503 : 200 });
    const results = await runSmoke(manifest, 'staging', { fetch: f, sleep: noSleep });
    expect(results[0]?.ok).toBe(true);
  });

  it('reports the status after the attempts run out', async () => {
    const { fetch: f } = fakeFetch((url) => new Response('ok', { status: url.includes('api') ? 200 : 502 }));
    const results = await runSmoke(manifest, 'staging', { fetch: f, sleep: noSleep });
    expect(results[0]).toEqual({ url: 'https://staging.example.com/', ok: false, detail: 'HTTP 502 (3 attempts)' });
  });

  it('names the missing text without leaking the body', async () => {
    const { fetch: f } = fakeFetch(() => new Response('secret@example.com'));
    const results = await runSmoke(manifest, 'staging', { fetch: f, sleep: noSleep });
    const failed = results.find((r) => !r.ok);
    expect(failed?.detail).toContain('did not contain "\\"slug\\":\\"demo\\""');
    expect(JSON.stringify(results)).not.toContain('secret@example.com');
  });

  it('reports a network error', async () => {
    const f: typeof fetch = async () => {
      throw new Error('connection refused');
    };
    const results = await runSmoke(manifest, 'staging', { fetch: f, sleep: noSleep });
    expect(results[0]?.detail).toBe('connection refused (3 attempts)');
  });
});

describe('smokeComponent', () => {
  it('is undefined when all passed', () => {
    expect(smokeComponent(manifest, 'staging', [{ url: 'https://x', ok: true, detail: 'answered' }])).toBeUndefined();
  });

  it('is a failed component naming the URL, reason and the rollback command', () => {
    const component = smokeComponent(manifest, 'staging', [{ url: 'https://x', ok: false, detail: 'HTTP 502 (3 attempts)' }]);
    expect(component?.status).toBe('failed');
    expect(component?.detail).toContain('https://x: HTTP 502 (3 attempts)');
    expect(component?.detail).toContain('ship rollback creatrgrid staging');
  });
});

describe('smokeAfterDeploy', () => {
  const failing = fakeFetch(() => new Response(null, { status: 500 }));
  const options = { fetch: failing.fetch, sleep: noSleep };

  it('adds a failed smoke component after a clean deploy', async () => {
    const result = await smokeAfterDeploy(manifest, 'staging', [{ name: 'api', status: 'deployed' }], options);
    expect(result?.name).toBe('smoke');
    expect(result?.status).toBe('failed');
  });

  it('does not request anything when a component was rolled back or failed', async () => {
    failing.urls.length = 0;
    expect(await smokeAfterDeploy(manifest, 'staging', [{ name: 'api', status: 'rolled-back' }], options)).toBeUndefined();
    expect(failing.urls).toEqual([]);
  });
});
