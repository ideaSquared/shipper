// What `ship logs` does: stream `wrangler tail` for a deployed environment. The planning is pure; the
// process layer is injected (see `spawnTail`) so tests never spawn anything.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { environmentOf, type Manifest } from './manifest.ts';
import { repoFromRemote } from './products.ts';

export type TailPlan = { name: string; command: string; args: string[]; cwd: string };
export type LogsPlan = { tails: TailPlan[]; skipped: string[] };

// A running child. `done` resolves with its exit code, or rejects if it could not be started.
export type TailProcess = { done: Promise<number>; stop: () => void };
export type SpawnTail = (plan: TailPlan, onLine: (line: string) => void) => TailProcess;

// Tailing needs the component's wrangler config, so the folder has to be a checkout of the product's repo.
export function assertCheckout(repo: string, remote: string | undefined): void {
  const actual = remote ? repoFromRemote(remote) : undefined;
  if (actual?.toLowerCase() === repo.toLowerCase()) return;
  throw new Error(`ship logs needs the component's wrangler config: run this inside a checkout of ${repo}.`);
}

// One `wrangler tail` per cloudflare-worker component (or just `only`); external components can't be tailed.
export function planLogs(manifest: Manifest, environment: string, repoRoot: string, only?: string): LogsPlan {
  if (only && !(only in manifest.components)) {
    throw new Error(`No component '${only}' in ship.yaml. It has: ${Object.keys(manifest.components).join(', ')}.`);
  }
  const wranglerEnv = environmentOf(manifest, environment).wranglerEnv;
  const envArgs = wranglerEnv ? ['--env', wranglerEnv] : [];
  const chosen = Object.entries(manifest.components).filter(([name]) => !only || name === only);
  const tails = chosen.flatMap(([name, component]) =>
    component.type === 'cloudflare-worker'
      ? [{ name, command: 'pnpm', args: ['exec', 'wrangler', 'tail', '--format', 'pretty', ...envArgs], cwd: join(repoRoot, component.path) }]
      : [],
  );
  const skipped = chosen.filter(([, component]) => component.type !== 'cloudflare-worker').map(([name]) => name);
  return { tails, skipped };
}

export type LogsIo = {
  spawnTail: SpawnTail;
  print: (line: string) => void;
  // Called once with a function that stops every child (the CLI wires it to Ctrl-C).
  onStop?: (stop: () => void) => void;
};

export async function logs(plan: LogsPlan, io: LogsIo): Promise<number> {
  plan.skipped.forEach((name) => io.print(`⏭️  ${name} is external: shipper can't tail it, so it is skipped.`));
  if (plan.tails.length === 0) {
    io.print('❌ No component can be tailed: shipper only tails cloudflare-worker components.');
    return 1;
  }
  const prefixed = plan.tails.length > 1;
  const width = Math.max(...plan.tails.map((t) => t.name.length));
  let stopped = false;
  const children = plan.tails.map((tail) => {
    const label = `[${tail.name}]`.padEnd(width + 2);
    const onLine = (line: string) => io.print(prefixed ? `${label} ${line}` : line);
    try {
      return { tail, child: io.spawnTail(tail, onLine) };
    } catch (error) {
      return { tail, child: { done: Promise.reject(error), stop: () => {} } };
    }
  });
  io.onStop?.(() => {
    stopped = true;
    children.forEach(({ child }) => child.stop());
  });
  const codes = await Promise.all(
    children.map(({ tail, child }) =>
      child.done.catch((error: unknown) => {
        io.print(`❌ ${tail.name}: could not start wrangler (${error instanceof Error ? error.message : String(error)})`);
        return 1;
      }),
    ),
  );
  // After Ctrl-C the children's own exit codes (killed by a signal) are not failures.
  return stopped ? 0 : codes.some((code) => code !== 0) ? 1 : 0;
}

// The thin process layer: wrangler's own auth (CLOUDFLARE_API_TOKEN or `wrangler login`) comes from the
// inherited environment, and nothing here prints it.
export const spawnTail: SpawnTail = (plan, onLine) => {
  const child = spawn(plan.command, plan.args, { cwd: plan.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  [child.stdout, child.stderr].forEach((stream) => createInterface({ input: stream }).on('line', onLine));
  const done = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
  return { done, stop: () => void child.kill('SIGINT') };
};
