import { createInterface } from 'node:readline/promises';

export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) throw new Error('Not a terminal, so ship cannot ask. Pass --yes to deploy without asking.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY)
    throw new Error('Not a terminal, so ship cannot ask. Production needs its name typed, and --yes does not skip that: run it from a terminal.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} `);
  rl.close();
  return answer;
}
