import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;

function ship(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ['src/cli.ts', ...args], {
    encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', ...env },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('the ship command line', () => {
  it('prints the package version to stdout and exits 0', () => {
    const result = ship(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(packageVersion);
  });

  it('prints usage to stdout and exits 0 for --help and -h', () => {
    for (const flag of ['--help', '-h']) {
      const result = ship([flag]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Options:');
    }
  });

  it('prints no colour when NO_COLOR is set', () => {
    const result = ship(['--help'], { NO_COLOR: '1', FORCE_COLOR: '1' });
    expect(result.stdout).not.toContain('\u001b[');
  });
});
