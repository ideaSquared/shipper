#!/usr/bin/env node
// ship: deploy any ideaSquared product from any folder. See the README for the commands.
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { deploy, diff, loadContext, log, rollback, status, statusAll } from './commands.ts';
import { createGitHubClient } from './github.ts';
import { parseTarget, PRODUCTS, repoFromRemote, resolveRepo } from './products.ts';
import { terminalStyle } from './style.ts';

const HELP = `🚢 ship: deploy ideaSquared products

  ship status [product]              what is live in each environment (no product: every product)
  ship diff [product] [env]          commits waiting to ship
  ship log [product] [env] [-n 10]   recent deploys
  ship deploy [product] [env]        check, confirm, start the deploy and follow it
  ship <env> [product]               same as deploy
  ship rollback [product] [env]      put back the commit that was live before (--to <sha> for another)

Options:
  --repo owner/name   a repo not in the product list
  -y, --yes           don't ask before deploying or rolling back (production still asks
                      for the product name)
  --no-wait           start the deploy and exit
  --redeploy          deploy even if that commit is already live
  --to <sha>          rollback: the earlier live commit to put back (7+ characters)

Products: ${Object.keys(PRODUCTS).join(', ')}. Inside a repo's folder the product is optional.
Sign-in: GH_TOKEN, GITHUB_TOKEN or your gh login.`;

function quiet(command: string, args: string[]): string | undefined {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) throw new Error('Not a terminal, so ship cannot ask. Pass --yes to deploy without asking.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Not a terminal, so ship cannot ask. Production needs its name typed in a terminal.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} `);
  rl.close();
  return answer;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      yes: { type: 'boolean', short: 'y', default: false },
      'no-wait': { type: 'boolean', default: false },
      redeploy: { type: 'boolean', default: false },
      to: { type: 'string' },
      n: { type: 'string', short: 'n', default: '10' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [first, ...rest] = positionals;
  if (values.help || !first || first === 'help') {
    console.log(HELP);
    return values.help || first === 'help' ? 0 : 2;
  }

  const known = ['status', 'diff', 'log', 'deploy', 'rollback'];
  const command = known.includes(first) ? first : 'deploy';
  const args = known.includes(first) ? rest : positionals;
  const { product, environment } = parseTarget(args);

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || quiet('gh', ['auth', 'token']);
  const style = terminalStyle(process.stdout);
  const print = (line: string) => console.log(line);
  const choice = { repo: values.repo, product, remote: quiet('git', ['remote', 'get-url', 'origin']) };

  // `ship status` outside any product's folder (including another repo's), or `ship status all`.
  const remoteRepo = repoFromRemote(choice.remote ?? '')?.toLowerCase();
  const inProductFolder = Object.values(PRODUCTS).some((repo) => repo.toLowerCase() === remoteRepo);
  const wantsAll = environment === 'all' || (!choice.repo && !choice.product && !inProductFolder);
  if (command === 'status' && wantsAll) {
    return statusAll(PRODUCTS, (repo, out) => loadContext(createGitHubClient(repo, token), repo, out, Boolean(token), style), print, style);
  }

  const repo = resolveRepo(choice);
  const client = createGitHubClient(repo, token);
  const ctx = await loadContext(client, repo, print, Boolean(token), style);

  if (command === 'status') return status(ctx);
  if (command === 'diff') return diff(ctx, environment);
  if (command === 'log') return log(ctx, environment, Number(values.n) || 10);
  const run = { yes: values.yes, wait: !values['no-wait'], confirm, ask, now: () => new Date(), sleep: (ms: number) => sleep(ms) };
  if (command === 'rollback') return rollback(ctx, environment, { ...run, to: values.to });
  return deploy(ctx, environment, { ...run, redeploy: values.redeploy });
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const red = terminalStyle(process.stderr).bad;
    console.error(`❌ ${red('ship:')} ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
