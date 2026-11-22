import { afterEach, describe, expect, it } from 'vitest';
import { ask, confirm } from '../src/prompts.ts';

const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

function withoutTerminal() {
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
}

afterEach(() => {
  if (original) Object.defineProperty(process.stdin, 'isTTY', original);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
});

describe('prompts without a terminal', () => {
  it('refuses to ask a yes/no question and names the flag that skips it', async () => {
    withoutTerminal();
    await expect(confirm('Deploy?')).rejects.toThrow(/Not a terminal.*--yes/);
  });

  it('refuses to ask for the product name, since --yes never skips it', async () => {
    withoutTerminal();
    await expect(ask('Type it:')).rejects.toThrow(/Not a terminal.*--yes does not skip that/);
  });
});
