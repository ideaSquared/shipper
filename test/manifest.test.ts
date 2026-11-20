import { describe, expect, it } from 'vitest';
import { environmentOf, healthFor, parseManifest } from '../src/manifest.ts';

const VALID = `
product: creatrgrid
checks: [verify]
environments:
  staging: { wranglerEnv: staging }
  production:
    requires: [staging]
components:
  api:
    type: cloudflare-worker
    path: services/api
    migrations: { d1: creatorgrid-db }
    health: /api/v1/health
  web:
    type: cloudflare-worker
    path: apps/web
    build: pnpm --filter @creatorgrid/app.web build
`;

describe('parseManifest', () => {
  it('reads the optional top-level migrations directories', () => {
    expect(parseManifest(VALID).migrations).toBeUndefined();
    expect(parseManifest(`${VALID}migrations: [packages/db/migrations]\n`).migrations).toEqual(['packages/db/migrations']);
    expect(() => parseManifest(`${VALID}migrations: ''\n`)).toThrow('migrations');
  });

  it('reads a valid manifest and keeps component order', () => {
    const manifest = parseManifest(VALID);
    expect(Object.keys(manifest.components)).toEqual(['api', 'web']);
    expect(manifest.environments.production?.requires).toEqual(['staging']);
    expect(manifest.checks).toEqual(['verify']);
  });

  it('fills in defaults for the smallest manifest', () => {
    const manifest = parseManifest(`
product: gaminginit-bot
environments: { production: {} }
components: { bot: { type: cloudflare-worker } }
`);
    expect(manifest.checks).toEqual([]);
    expect(manifest.environments.production).toEqual({ requires: [] });
    expect(manifest.components.bot).toMatchObject({ type: 'cloudflare-worker', path: '.' });
  });

  it('rejects unknown keys so typos are caught', () => {
    expect(() =>
      parseManifest(`
product: x
environments: { production: {} }
components: { bot: { type: cloudflare-worker, heath: /health } }
`),
    ).toThrow(/components\.bot/);
  });

  it('rejects an environment that requires one that does not exist', () => {
    expect(() =>
      parseManifest(`
product: x
environments: { production: { requires: [staging] } }
components: { bot: { type: cloudflare-worker } }
`),
    ).toThrow(/unknown environment 'staging'/);
  });

  it('takes a health check per environment, naming only environments it has', () => {
    const manifest = parseManifest(`
product: x
environments: { staging: {}, production: {} }
components: { api: { type: cloudflare-worker, health: { staging: /health, production: https://x.dev/health } } }
`);
    expect(manifest.components.api).toMatchObject({ health: { staging: '/health', production: 'https://x.dev/health' } });
    expect(() =>
      parseManifest(`
product: x
environments: { production: {} }
components: { api: { type: cloudflare-worker, health: { prod: /health } } }
`),
    ).toThrow(/components\.api\.health\.prod: unknown environment 'prod'/);
  });

  it('takes a health check as a plain string or as { url, expect }, per environment', () => {
    const manifest = parseManifest(`
product: x
environments: { staging: {}, production: {} }
components:
  api:
    type: cloudflare-worker
    health:
      staging: { url: /health, expect: '"status":"ok"' }
      production: https://x.dev/health
  web: { type: cloudflare-worker, health: /up }
`);
    const { api, web } = manifest.components;
    if (api?.type !== 'cloudflare-worker' || web?.type !== 'cloudflare-worker') throw new Error('expected workers');
    expect(healthFor(api, 'staging')).toEqual({ url: '/health', expect: '"status":"ok"' });
    expect(healthFor(api, 'production')).toEqual({ url: 'https://x.dev/health' });
    expect(healthFor(web, 'staging')).toEqual({ url: '/up' });
  });

  it('rejects an empty expect and unknown keys in a health check', () => {
    const manifest = (check: string) => `
product: x
environments: { production: {} }
components: { api: { type: cloudflare-worker, health: { production: ${check} } } }
`;
    expect(() => parseManifest(manifest('{ url: /h, expect: "" }'))).toThrow(/ship.yaml is invalid/);
    expect(() => parseManifest(manifest('{ url: /h, expects: ok }'))).toThrow(/ship.yaml is invalid/);
  });

  it('rejects a manifest with no components', () => {
    expect(() => parseManifest('product: x\nenvironments: { production: {} }\ncomponents: {}\n')).toThrow(
      /at least one component/,
    );
  });

  it('rejects component types it cannot deploy yet', () => {
    expect(() =>
      parseManifest(`
product: x
environments: { production: {} }
components: { app: { type: compose-ssh } }
`),
    ).toThrow(/components\.app/);
  });
});

describe('environmentOf', () => {
  it('names the known environments when asked for an unknown one', () => {
    expect(() => environmentOf(parseManifest(VALID), 'prod')).toThrow(/known: staging, production/);
  });
});

describe('external components', () => {
  it('accepts a component the repo deploys with its own workflow', () => {
    const manifest = parseManifest(`
product: ads
environments: { staging: {}, production: { requires: [staging] } }
components: { stack: { type: external, workflow: .github/workflows/deploy.yml } }
`);
    expect(manifest.components.stack).toEqual({ type: 'external', workflow: '.github/workflows/deploy.yml' });
  });
});

