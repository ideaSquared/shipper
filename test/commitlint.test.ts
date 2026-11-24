import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const lint = (title: string) => spawnSync('pnpm', ['exec', 'commitlint'], { input: `${title}\n`, encoding: 'utf8' }).status;

describe('commitlint config', () => {
  it('accepts Dependabot bump titles', () => {
    expect(lint('chore(deps): Bump typescript from 5.9.3 to 6.0.3')).toBe(0);
  });

  it('still rejects a title that is not a Conventional Commit', () => {
    expect(lint('Bump typescript')).not.toBe(0);
  });
});
