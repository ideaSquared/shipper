import { describe, expect, it } from 'vitest';
import { evaluateGate, type GateFacts } from '../src/gate.ts';
import { parseManifest } from '../src/manifest.ts';

const manifest = parseManifest(`
product: creatrgrid
checks: [verify, e2e]
environments:
  staging: {}
  production: { requires: [staging] }
components: { api: { type: cloudflare-worker } }
`);

const SHA = 'abcdef1234567890abcdef1234567890abcdef12';

const passing: GateFacts = {
  sha: SHA,
  defaultBranch: 'main',
  onDefaultBranch: true,
  checkRuns: [
    { name: 'verify', status: 'completed', conclusion: 'success' },
    { name: 'e2e', status: 'completed', conclusion: 'success' },
  ],
  deployedTo: ['staging'],
};

describe('evaluateGate', () => {
  it('lets a commit through when every rule holds', () => {
    expect(evaluateGate(manifest, 'production', passing)).toEqual({ ok: true, failures: [] });
  });

  it('blocks a commit that is not on the default branch', () => {
    const result = evaluateGate(manifest, 'staging', { ...passing, onDefaultBranch: false });
    expect(result.failures).toEqual(['abcdef1 is not on main']);
  });

  it('explains missing, running and failed checks separately', () => {
    const result = evaluateGate(manifest, 'staging', {
      ...passing,
      checkRuns: [{ name: 'verify', status: 'in_progress', conclusion: null }],
    });
    expect(result.failures).toEqual(["check 'verify' is still running", "check 'e2e' has not run on this commit"]);

    const failed = evaluateGate(manifest, 'staging', {
      ...passing,
      checkRuns: [...passing.checkRuns.slice(1), { name: 'verify', status: 'completed', conclusion: 'failure' }],
    });
    expect(failed.failures).toEqual(["check 'verify' did not pass"]);
  });

  it('accepts a check that passed on a re-run after an earlier failure', () => {
    const result = evaluateGate(manifest, 'staging', {
      ...passing,
      checkRuns: [
        ...passing.checkRuns,
        { name: 'verify', status: 'completed', conclusion: 'failure' },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('only sends production a commit that is already live on staging', () => {
    const result = evaluateGate(manifest, 'production', { ...passing, deployedTo: [] });
    expect(result.failures).toEqual(['abcdef1 has not been deployed successfully to staging']);
  });

  it('does not ask staging to have been deployed before staging', () => {
    expect(evaluateGate(manifest, 'staging', { ...passing, deployedTo: [] }).ok).toBe(true);
  });

  it('blocks a commit older than, or not built on, what is live', () => {
    const LIVE = 'fedcba9876543210fedcba9876543210fedcba98';
    expect(evaluateGate(manifest, 'staging', { ...passing, live: { sha: LIVE, relation: 'behind' } }).failures).toEqual([
      'abcdef1 is older than fedcba9, which is live on staging',
    ]);
    expect(evaluateGate(manifest, 'staging', { ...passing, live: { sha: LIVE, relation: 'diverged' } }).failures).toEqual([
      'abcdef1 is not built on fedcba9, which is live on staging',
    ]);
    expect(evaluateGate(manifest, 'staging', { ...passing, live: { sha: LIVE, relation: 'ahead' } }).ok).toBe(true);
    expect(evaluateGate(manifest, 'staging', { ...passing, live: { sha: LIVE, relation: 'identical' } }).ok).toBe(true);
  });
});
