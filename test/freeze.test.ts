import { describe, expect, it } from 'vitest';
import type { Context } from '../src/commands.ts';
import { freeze, freezeFromVariable, parseFreeze, unfreeze, FREEZE_VARIABLE } from '../src/freeze.ts';
import type { GitHubClient } from '../src/github.ts';
import { parseManifest } from '../src/manifest.ts';
import { plain } from '../src/style.ts';

const MANIFEST = `
product: gaminginit-bot
environments:
  staging: {}
  production: {}
components:
  bot: { type: cloudflare-worker }
`;

// A client whose only real state is the one variable.
function store(initial?: unknown) {
  const state = { value: initial === undefined ? undefined : JSON.stringify(initial) };
  const client = {
    readVariable: async () => state.value,
    writeVariable: async (_name: string, value: string) => {
      state.value = value;
    },
    deleteVariable: async () => {
      state.value = undefined;
    },
    currentUser: async () => 'hubot',
  } as unknown as GitHubClient;
  return { state, client, saved: () => (state.value === undefined ? undefined : JSON.parse(state.value)) };
}

function context(client: GitHubClient): { ctx: Context; lines: string[] } {
  const lines: string[] = [];
  const ctx = {
    client,
    repo: 'acme/app',
    manifest: parseManifest(MANIFEST),
    defaultBranch: 'main',
    head: 'c',
    print: (line: string) => lines.push(line),
    canWrite: true,
    timeZone: 'UTC',
    style: plain,
  } satisfies Partial<Context> as Context;
  return { ctx, lines };
}

const options = (overrides: Partial<Parameters<typeof freeze>[2]> = {}) => ({
  yes: true,
  confirm: async () => true,
  now: () => new Date('2026-11-13T21:00:00Z'),
  reason: 'db incident',
  ...overrides,
});

const existing = { environments: ['production'], reason: 'old', by: 'octocat', at: '2026-11-13T20:00:00Z' };

describe('freeze', () => {
  it('freezes every environment when none is named, recording the reason, the login and the time', async () => {
    const { client, saved } = store();
    expect(await freeze(context(client).ctx, undefined, options())).toBe(0);
    expect(saved()).toEqual({ environments: 'all', reason: 'db incident', by: 'hubot', at: '2026-11-13T21:00:00.000Z' });
  });

  it('freezes one environment', async () => {
    const { client, saved } = store();
    await freeze(context(client).ctx, 'production', options());
    expect(saved().environments).toEqual(['production']);
  });

  it('adds to an existing freeze rather than dropping it, and shows what was already frozen', async () => {
    const { client, saved } = store(existing);
    const { ctx, lines } = context(client);
    await freeze(ctx, 'staging', options());
    // production was frozen, staging joins it: that is every environment this product has.
    expect(saved().environments).toBe('all');
    expect(lines[0]).toBe('❄️  frozen: production');
  });

  it('keeps a freeze someone added while the prompt was open', async () => {
    const { client, state, saved } = store();
    const confirm = async () => ((state.value = JSON.stringify({ ...existing, environments: ['staging'] })), true);
    await freeze(context(client).ctx, 'production', options({ yes: false, confirm }));
    expect(saved().environments).toBe('all');
  });

  it('needs a reason', async () => {
    const { client, state } = store();
    await expect(freeze(context(client).ctx, undefined, options({ reason: ' ' }))).rejects.toThrow('A freeze needs a reason');
    expect(state.value).toBeUndefined();
  });

  it('names the environments when the one asked for does not exist', async () => {
    await expect(freeze(context(store().client).ctx, 'qa', options())).rejects.toThrow("No environment 'qa' in ship.yaml. It has: staging, production.");
  });

  it('asks first unless --yes, and does nothing on no', async () => {
    const { client, state } = store();
    const { ctx, lines } = context(client);
    expect(await freeze(ctx, undefined, options({ yes: false, confirm: async () => false }))).toBe(1);
    expect(state.value).toBeUndefined();
    expect(lines).toEqual(['🙅 Not frozen.']);
  });
});

describe('unfreeze', () => {
  it('lifts everything when no environment is named', async () => {
    const { client, state } = store({ ...existing, environments: 'all' });
    expect(await unfreeze(context(client).ctx, undefined, options())).toBe(0);
    expect(state.value).toBeUndefined();
  });

  it('lifts one environment out of an "all" freeze and keeps the rest frozen', async () => {
    const { client, saved } = store({ ...existing, environments: 'all' });
    await unfreeze(context(client).ctx, 'staging', options());
    expect(saved()).toEqual({ ...existing, environments: ['production'] });
  });

  it('removes the freeze when the last frozen environment is lifted', async () => {
    const { client, state } = store(existing);
    await unfreeze(context(client).ctx, 'production', options());
    expect(state.value).toBeUndefined();
  });

  it('says so when there is nothing to lift', async () => {
    const { client } = store(existing);
    const { ctx, lines } = context(client);
    expect(await unfreeze(ctx, 'staging', options())).toBe(0);
    expect(lines).toEqual(['✅ staging is not frozen.']);
  });

  it('keeps an environment someone froze while the prompt was open', async () => {
    const { client, state, saved } = store(existing);
    const confirm = async () => ((state.value = JSON.stringify({ ...existing, environments: ['production', 'staging'] })), true);
    await unfreeze(context(client).ctx, 'production', options({ yes: false, confirm }));
    expect(saved().environments).toEqual(['staging']);
  });

  it('removes a malformed value when lifting everything, but not one environment of it', async () => {
    const { client, state } = store();
    state.value = 'not json';
    await expect(unfreeze(context(client).ctx, 'production', options())).rejects.toThrow('SHIP_FREEZE is not a valid freeze');
    expect(state.value).toBe('not json');
    const { ctx, lines } = context(client);
    expect(await unfreeze(ctx, undefined, options())).toBe(0);
    expect(state.value).toBeUndefined();
    expect(lines[0]).toContain('SHIP_FREEZE is not a valid freeze, so it blocks every deploy');
  });

  it('leaves the freeze alone when not confirmed', async () => {
    const { client, saved } = store(existing);
    expect(await unfreeze(context(client).ctx, undefined, options({ yes: false, confirm: async () => false }))).toBe(1);
    expect(saved()).toEqual(existing);
  });
});

describe('the freeze variable', () => {
  it('is not frozen when the workflow variable is unset or empty', () => {
    expect(freezeFromVariable(undefined)).toEqual({});
    expect(freezeFromVariable('')).toEqual({});
  });

  it('reads what ship freeze wrote', () => {
    expect(freezeFromVariable(JSON.stringify(existing))).toEqual({ freeze: existing });
  });

  it('blocks on a value it cannot read rather than letting a deploy through', () => {
    expect(freezeFromVariable('{oops').failure).toBe(`${FREEZE_VARIABLE} is not a valid freeze. Run \`ship unfreeze\` and freeze again.`);
    expect(() => parseFreeze('{"environments":[],"reason":"x","by":"y","at":"z"}')).toThrow('not a valid freeze');
  });
});
