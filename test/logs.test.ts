import { describe, expect, it } from 'vitest';
import { assertCheckout, logs, planLogs, type SpawnTail, type TailPlan } from '../src/logs.ts';
import { parseManifest } from '../src/manifest.ts';

const MANIFEST = parseManifest(`
product: demo
environments:
  staging:
    wranglerEnv: stg
  production: {}
components:
  api:
    type: cloudflare-worker
    path: services/api
  web:
    type: cloudflare-worker
    path: apps/web
  legacy:
    type: external
    workflow: .github/workflows/deploy.yml
`);

describe('assertCheckout', () => {
  it('accepts a remote for the product repo, in either URL form', () => {
    expect(() => assertCheckout('o/demo', 'git@github.com:o/demo.git')).not.toThrow();
    expect(() => assertCheckout('o/demo', 'https://github.com/O/Demo')).not.toThrow();
  });
  it('refuses another repo or no remote, naming the repo', () => {
    expect(() => assertCheckout('o/demo', 'git@github.com:o/other.git')).toThrow('inside a checkout of o/demo');
    expect(() => assertCheckout('o/demo', undefined)).toThrow('inside a checkout of o/demo');
  });
});

describe('planLogs', () => {
  it('plans one wrangler tail per worker in its path, adding --env, and lists external ones as skipped', () => {
    const plan = planLogs(MANIFEST, 'staging', '/repo');
    expect(plan.tails).toEqual([
      { name: 'api', command: 'pnpm', args: ['exec', 'wrangler', 'tail', '--format', 'pretty', '--env', 'stg'], cwd: '/repo/services/api' },
      { name: 'web', command: 'pnpm', args: ['exec', 'wrangler', 'tail', '--format', 'pretty', '--env', 'stg'], cwd: '/repo/apps/web' },
    ]);
    expect(plan.skipped).toEqual(['legacy']);
  });
  it('leaves out --env when the environment has no wranglerEnv', () => {
    expect(planLogs(MANIFEST, 'production', '/repo', 'api').tails[0]?.args).toEqual(['exec', 'wrangler', 'tail', '--format', 'pretty']);
  });
  it('limits to --component and rejects an unknown one', () => {
    expect(planLogs(MANIFEST, 'staging', '/repo', 'web').tails.map((t) => t.name)).toEqual(['web']);
    expect(() => planLogs(MANIFEST, 'staging', '/repo', 'nope')).toThrow("No component 'nope'");
  });
});

function fakeSpawn(behaviour: (plan: TailPlan, onLine: (line: string) => void) => Promise<number>) {
  const stops: string[] = [];
  const spawnTail: SpawnTail = (plan, onLine) => ({ done: behaviour(plan, onLine), stop: () => void stops.push(plan.name) });
  return { spawnTail, stops };
}

describe('logs', () => {
  it('prefixes each line with the component name when there are several', async () => {
    const out: string[] = [];
    const { spawnTail } = fakeSpawn(async (plan, onLine) => (onLine(`hello from ${plan.name}`), 0));
    const code = await logs(planLogs(MANIFEST, 'staging', '/repo'), { spawnTail, print: (l) => out.push(l) });
    expect(code).toBe(0);
    expect(out).toContain('[api] hello from api');
    expect(out).toContain('[web] hello from web');
    expect(out.some((l) => l.includes('legacy') && l.includes("can't tail"))).toBe(true);
  });
  it('leaves a single component unprefixed', async () => {
    const out: string[] = [];
    const { spawnTail } = fakeSpawn(async (_plan, onLine) => (onLine('one'), 0));
    await logs(planLogs(MANIFEST, 'staging', '/repo', 'api'), { spawnTail, print: (l) => out.push(l) });
    expect(out).toEqual(['one']);
  });
  it('exits 1 when a child fails to start', async () => {
    const out: string[] = [];
    const { spawnTail } = fakeSpawn(async (plan) => {
      if (plan.name === 'web') throw new Error('spawn pnpm ENOENT');
      return 0;
    });
    const code = await logs(planLogs(MANIFEST, 'staging', '/repo'), { spawnTail, print: (l) => out.push(l) });
    expect(code).toBe(1);
    expect(out.some((l) => l.includes('web') && l.includes('ENOENT'))).toBe(true);
  });
  it('still exits 1 for a failed start when Ctrl-C stops a sibling that kept streaming', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { spawnTail } = fakeSpawn(async (plan) => {
      if (plan.name === 'web') throw new Error('spawn pnpm ENOENT');
      return (await gate, 130);
    });
    const result = logs(planLogs(MANIFEST, 'staging', '/repo'), {
      spawnTail,
      print: () => {},
      onStop: (stop) => setTimeout(() => (stop(), release()), 0),
    });
    expect(await result).toBe(1);
  });
  it('exits 1 with a message when only external components remain', async () => {
    const out: string[] = [];
    const { spawnTail } = fakeSpawn(async () => 0);
    const code = await logs(planLogs(MANIFEST, 'staging', '/repo', 'legacy'), { spawnTail, print: (l) => out.push(l) });
    expect(code).toBe(1);
    expect(out.join('\n')).toContain('No component can be tailed');
  });
  it('stops every child on stop and then exits cleanly', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { spawnTail, stops } = fakeSpawn(async () => (await gate, 130));
    const result = logs(planLogs(MANIFEST, 'staging', '/repo'), {
      spawnTail,
      print: () => {},
      onStop: (stop) => queueMicrotask(() => (stop(), release())),
    });
    expect(await result).toBe(0);
    expect(stops).toEqual(['api', 'web']);
  });
});
