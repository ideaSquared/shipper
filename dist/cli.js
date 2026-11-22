#!/usr/bin/env node
// ship: deploy any ideaSquared product from any folder. See the README for the commands.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { deploy, diff, loadContext, log, pickEnvironment, rollback, status, statusAll } from "./commands.js";
import { freeze, unfreeze } from "./freeze.js";
import { doctor } from "./doctor.js";
import { createGitHubClient } from "./github.js";
import { assertCheckout, logs, planLogs, spawnTail } from "./logs.js";
import { parseManifest } from "./manifest.js";
import { ask, confirm } from "./prompts.js";
import { GitHubApiError, isAccessError } from "./github.js";
import { accessHint, RATE_LIMIT_HINT, activeProducts, assertShippable, ownerFromCodeowners, parseTarget, productForRepo, PRODUCTS, repoFromRemote, resolveRepo, } from "./products.js";
import { terminalStyle } from "./style.js";
const HELP = `🚢 ship: deploy ideaSquared products

  ship status [product]              what is live in each environment (no product: every product)
  ship diff [product] [env]          commits waiting to ship
  ship log [product] [env] [-n 10]   recent deploys
  ship deploy [product] [env]        check, confirm, start the deploy and follow it
  ship <env> [product]               same as deploy
  ship logs [product] [env]          stream live logs of a deployed environment (inside the checkout; --component <name>)
  ship rollback [product] [env]      put back the commit that was live before (--to <sha> for another)
  ship freeze [product] [env]        block deploys (no env: all) with --reason "…"; rollbacks still work
  ship unfreeze [product] [env]      lift it (no env: everything)
  ship doctor [product] [env]        check the deploy setup before deploying (exit 1 if something fails)

Options:
  --version           print the installed version
  --repo owner/name   a repo not in the product list
  -y, --yes           don't ask before deploying or rolling back (production still asks
                      for the product name)
  --no-wait           start the deploy and exit
  --redeploy          deploy even if that commit is already live
  --reason "…"        freeze: why, shown to everyone who tries to deploy
  --to <sha>          rollback: the earlier live commit to put back (7+ characters)

Products (inside a repo's folder the product is optional):
${Object.entries(PRODUCTS)
    .map(([name, product]) => `  ${name.padEnd(17)}${product.description}${product.retired ? ` · 🪦 retired: ${product.retired}` : ''}`)
    .join('\n')}
Sign-in: GH_TOKEN, GITHUB_TOKEN or your gh login.`;
function quiet(command, args) {
    try {
        return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
    }
    catch {
        return undefined;
    }
}
// The repo being worked on, so a GitHub refusal can name its owner.
let current;
async function ownerOf(client) {
    for (const path of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
        const text = await client.readFile(path, 'HEAD').catch(() => undefined);
        if (text)
            return ownerFromCodeowners(text);
    }
    return undefined;
}
// package.json sits one folder above both src/ and dist/.
function shipVersion() {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return version;
}
async function main() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            repo: { type: 'string' },
            yes: { type: 'boolean', short: 'y', default: false },
            'no-wait': { type: 'boolean', default: false },
            redeploy: { type: 'boolean', default: false },
            to: { type: 'string' },
            reason: { type: 'string' },
            component: { type: 'string' },
            n: { type: 'string', short: 'n', default: '10' },
            help: { type: 'boolean', short: 'h', default: false },
            version: { type: 'boolean', default: false },
        },
    });
    if (values.version) {
        console.log(shipVersion());
        return 0;
    }
    const [first, ...rest] = positionals;
    if (values.help || !first || first === 'help') {
        console.log(HELP);
        return values.help || first === 'help' ? 0 : 2;
    }
    const known = ['status', 'diff', 'log', 'logs', 'deploy', 'rollback', 'doctor', 'freeze', 'unfreeze'];
    const command = known.includes(first) ? first : 'deploy';
    const args = known.includes(first) ? rest : positionals;
    const { product, environment } = parseTarget(args);
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || quiet('gh', ['auth', 'token']);
    const style = terminalStyle(process.stdout);
    const print = (line) => console.log(line);
    const choice = { repo: values.repo, product, remote: quiet('git', ['remote', 'get-url', 'origin']) };
    // `ship status` outside any product's folder (including another repo's), or `ship status all`.
    const remoteRepo = repoFromRemote(choice.remote ?? '')?.toLowerCase();
    const inProductFolder = Object.values(PRODUCTS).some((p) => p.repo.toLowerCase() === remoteRepo);
    const wantsAll = environment === 'all' || (!choice.repo && !choice.product && !inProductFolder);
    if (command === 'status' && wantsAll) {
        return statusAll(activeProducts(), (repo, out) => loadContext(createGitHubClient(repo, token), repo, out, Boolean(token), style), print, style);
    }
    const repo = resolveRepo(choice);
    // Checked against the resolved repo, so `ship production` inside a retired product's folder is
    // refused too. Only an explicit `--repo` bypasses it.
    if ((command === 'deploy' || command === 'rollback') && !values.repo)
        assertShippable(productForRepo(repo));
    if (command === 'logs') {
        // Local checkout only: the component's wrangler config is read from disk, not from GitHub.
        assertCheckout(repo, choice.remote);
        const root = quiet('git', ['rev-parse', '--show-toplevel']) ?? process.cwd();
        const manifest = parseManifest(readFileSync(`${root}/ship.yaml`, 'utf8'));
        const plan = planLogs(manifest, pickEnvironment(manifest, environment), root, values.component);
        return logs(plan, { spawnTail, print, onStop: (stop) => process.once('SIGINT', stop) });
    }
    const client = createGitHubClient(repo, token);
    current = { repo, client, writesVariables: command === 'freeze' || command === 'unfreeze' };
    if (command === 'doctor')
        return doctor(client, repo, { environment, print, style });
    const ctx = await loadContext(client, repo, print, Boolean(token), style);
    if (command === 'status')
        return status(ctx);
    if (command === 'diff')
        return diff(ctx, environment);
    if (command === 'log')
        return log(ctx, environment, Number(values.n) || 10);
    const run = { yes: values.yes, wait: !values['no-wait'], confirm, ask, now: () => new Date(), sleep: (ms) => sleep(ms) };
    // "all" is what an omitted environment means.
    const frozenEnvironment = environment === 'all' ? undefined : environment;
    if (command === 'freeze')
        return freeze(ctx, frozenEnvironment, { ...run, reason: values.reason });
    if (command === 'unfreeze')
        return unfreeze(ctx, frozenEnvironment, run);
    if (command === 'rollback')
        return rollback(ctx, environment, { ...run, to: values.to });
    return deploy(ctx, environment, { ...run, redeploy: values.redeploy });
}
main().then((code) => process.exit(code), async (error) => {
    const red = terminalStyle(process.stderr).bad;
    console.error(`❌ ${red('ship:')} ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof GitHubApiError && error.rateLimited)
        console.error(`⏳ ${RATE_LIMIT_HINT}`);
    else if (current && isAccessError(error)) {
        console.error(`🔑 ${accessHint(current.repo, await ownerOf(current.client))}`);
        if (current.writesVariables)
            console.error(`   Freezing writes the repo's SHIP_FREEZE Actions variable: it needs repo admin, or a fine-grained token with Variables: read and write.`);
    }
    process.exit(1);
});
