// What `ship status | diff | log | deploy` do. The CLI wires in GitHub, the terminal and the clock.
import { evaluateGate } from "./gate.js";
import { GitHubApiError } from "./github.js";
import { parseManifest } from "./manifest.js";
import { plain } from "./style.js";
export const DEFAULT_ROLLBACK_WORKFLOW = 'ship-rollback.yml';
const short = (sha) => sha.slice(0, 7);
export async function loadContext(client, repo, print, canWrite, style = plain, timeZone) {
    const defaultBranch = await client.defaultBranch();
    const [head, text] = await Promise.all([client.headSha(defaultBranch), client.readFile('ship.yaml', defaultBranch)]);
    if (text === undefined)
        throw new Error(`${repo} has no ship.yaml on ${defaultBranch}, so it doesn't deploy with shipper yet.`);
    return { client, repo, manifest: parseManifest(text), defaultBranch, head, print, canWrite, timeZone, style };
}
function formatTime(iso, timeZone) {
    return new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone,
    }).format(new Date(iso));
}
// The environment to act on: the one named, or the only one there is.
export function pickEnvironment(manifest, named) {
    const names = Object.keys(manifest.environments);
    if (named) {
        if (names.includes(named))
            return named;
        throw new Error(`No environment '${named}' in ship.yaml. It has: ${names.join(', ')}.`);
    }
    const [only, ...rest] = names;
    if (only && rest.length === 0)
        return only;
    throw new Error(`Name an environment: ${names.join(', ')}.`);
}
export async function status(ctx) {
    const { client, manifest, head, style: s } = ctx;
    ctx.print(`🚢 ${s.bold(manifest.product)} ${s.dim(`(${ctx.repo})`)} · ${ctx.defaultBranch} is at ${s.sha(short(head))}`);
    const rows = await Promise.all(Object.keys(manifest.environments).map(async (env) => {
        const [latest] = (await client.deployments(env, 20)).filter((d) => d.state === 'success' || d.state === 'inactive');
        const name = s.env(env.padEnd(12));
        if (!latest)
            return `⚪ ${name} ${s.dim('never deployed')}`;
        const upToDate = latest.sha === head;
        const behind = upToDate
            ? s.ok('up to date')
            : s.warn(`${(await client.compare(latest.sha, head)).totalCommits} commits behind`);
        return `${upToDate ? '🟢' : '🟡'} ${name} ${s.sha(short(latest.sha))}  ${s.dim(formatTime(latest.createdAt, ctx.timeZone))}  ${latest.creator}  ${behind}`;
    }));
    rows.forEach((row) => ctx.print(row));
    return 0;
}
// `ship status` with no product: every product, fetched together, printed in list order.
export async function statusAll(products, load, print, style) {
    const sections = await Promise.all(Object.entries(products).map(async ([name, repo]) => {
        const lines = [];
        try {
            await status(await load(repo, (line) => lines.push(line)));
            return lines;
        }
        catch (error) {
            // One line per product that can't be read, never a half-printed section above it.
            return [`⚠️  ${style.bold(name)} ${style.dim(`(${repo})`)}: ${error instanceof Error ? error.message : String(error)}`];
        }
    }));
    sections.forEach((lines, index) => {
        if (index > 0)
            print('');
        lines.forEach((line) => print(line));
    });
    return 0;
}
function printCommits(ctx, commits, total, max) {
    const newest = [...commits].reverse().slice(0, max);
    const s = ctx.style;
    newest.forEach((c) => ctx.print(`   ${s.sha(short(c.sha))} ${c.message} ${s.dim(`· ${c.author}`)}`));
    if (total > newest.length)
        ctx.print(s.dim(`   …and ${total - newest.length} more`));
}
export async function diff(ctx, environment) {
    const s = ctx.style;
    const env = pickEnvironment(ctx.manifest, environment);
    const live = await ctx.client.lastSuccessfulDeployment(env);
    if (!live) {
        ctx.print(`⚪ ${s.env(env)} has never been deployed. ${ctx.defaultBranch} is at ${s.sha(short(ctx.head))}.`);
        return 0;
    }
    if (live === ctx.head) {
        ctx.print(`🟢 ${s.env(env)} is ${s.ok('up to date')} at ${s.sha(short(live))}.`);
        return 0;
    }
    const comparison = await ctx.client.compare(live, ctx.head);
    ctx.print(`📦 ${s.env(env)}: ${s.sha(short(live))} → ${s.sha(short(ctx.head))} · ${s.warn(`${comparison.totalCommits} commits waiting`)}`);
    printCommits(ctx, comparison.commits, comparison.totalCommits, 50);
    ctx.print(`🔗 ${s.link(comparison.url)}`);
    return 0;
}
export async function log(ctx, environment, limit) {
    const env = pickEnvironment(ctx.manifest, environment);
    const deployments = await ctx.client.deployments(env, limit);
    const s = ctx.style;
    if (deployments.length === 0)
        ctx.print(`⚪ No deployments to ${s.env(env)} yet.`);
    deployments.forEach((d) => {
        const [icon, paint] = look(d.state, s);
        ctx.print(`${icon} ${s.dim(formatTime(d.createdAt, ctx.timeZone))}  ${s.sha(short(d.sha))}  ${paint(d.state.padEnd(11))} ${d.creator}`);
    });
    return 0;
}
// Icon and colour for deployment states and job results.
const STATE_LOOK = {
    success: ['✅', 'ok'],
    inactive: ['💤', 'dim'],
    failure: ['❌', 'bad'],
    error: ['❌', 'bad'],
    cancelled: ['🛑', 'bad'],
    skipped: ['⏭️', 'dim'],
};
// Anything not listed (queued, in_progress, pending…) is still running.
function look(state, s) {
    const [icon, tone] = STATE_LOOK[state] ?? ['⏳', 'warn'];
    return [icon, s[tone]];
}
function jobLine(job, s) {
    const result = job.conclusion ?? job.status;
    const [icon, paint] = look(result, s);
    return `   ${icon} ${job.name}: ${paint(result)}`;
}
export async function deploy(ctx, environment, options) {
    const { client, manifest, head, style: s } = ctx;
    const env = pickEnvironment(manifest, environment);
    if (!manifest.dispatch) {
        throw new Error('ship.yaml has no dispatch.workflow, so ship cannot start a deploy. See the shipper README.');
    }
    if (!ctx.canWrite)
        throw new Error('Deploying needs a GitHub token. Run `gh auth login` or set GH_TOKEN.');
    const requires = manifest.environments[env]?.requires ?? [];
    const [checkRuns, deployedTo, live] = await Promise.all([
        manifest.checks.length > 0 ? client.checkRuns(head) : Promise.resolve([]),
        client.deployedTo(head, requires),
        client.lastSuccessfulDeployment(env),
    ]);
    // Unknown history never blocks a deploy: if GitHub can't compare, warn and carry on.
    const unknown = (what) => (error) => {
        ctx.print(`⚠️  ${s.warn(`Could not ${what}: ${error instanceof Error ? error.message : String(error)}`)}`);
        return undefined;
    };
    const relation = live && live !== head ? await client.relation(live, head).catch(unknown(`compare ${short(head)} with the live ${short(live)}`)) : undefined;
    const gate = evaluateGate(manifest, env, {
        sha: head,
        defaultBranch: ctx.defaultBranch,
        onDefaultBranch: true,
        checkRuns,
        deployedTo,
        live: live && relation ? { sha: live, relation } : undefined,
    });
    if (!gate.ok) {
        ctx.print(`⛔ ${s.bad(`Can't ship ${short(head)} to ${env}:`)}`);
        gate.failures.forEach((failure) => ctx.print(`   • ${s.bad(failure)}`));
        return 1;
    }
    if (live === head && !options.redeploy) {
        ctx.print(`✅ ${s.sha(short(head))} is ${s.ok('already live')} on ${s.env(env)}. Nothing to ship ${s.dim('(use --redeploy to deploy it again)')}.`);
        return 0;
    }
    if (live && live !== head) {
        const comparison = await client.compare(live, head).catch(unknown('list the commits going out'));
        ctx.print(`📦 ${s.sha(short(live))} → ${s.sha(short(head))}${comparison ? ` · ${s.warn(`${comparison.totalCommits} commits`)}` : ''}`);
        if (comparison)
            printCommits(ctx, comparison.commits, comparison.totalCommits, 10);
    }
    else if (!live) {
        ctx.print(`🆕 First ship to ${s.env(env)}: ${s.sha(short(head))}`);
    }
    if (!options.yes && !(await options.confirm(`🚀 Ship ${s.sha(short(head))} to ${s.env(env)}?`))) {
        ctx.print(`🙅 ${s.dim('Not shipped.')}`);
        return 1;
    }
    const { workflow, environmentInput } = manifest.dispatch;
    const since = options.now();
    await client.dispatchWorkflow(workflow, ctx.defaultBranch, environmentInput ? { [environmentInput]: env } : {});
    return followRun(ctx, workflow, since, options, `🚀 ${s.ok(`Shipped ${short(head)} to ${env}.`)}`);
}
// Finds the run a dispatch started at `since`, prints each job as it changes, and ends with
// `shipped` or the failure. 0 when the run succeeded (or isn't being waited for).
async function followRun(ctx, workflow, since, options, shipped) {
    const { client, style: s } = ctx;
    const findRun = async (attempt) => {
        const run = await client.findDispatchedRun(workflow, since);
        if (run || attempt >= (options.findRunAttempts ?? 20))
            return run;
        await options.sleep(3000);
        return findRun(attempt + 1);
    };
    const started = await findRun(1);
    if (!started) {
        ctx.print(`⏳ Started, but the run hasn't appeared yet. Check ${s.link(`https://github.com/${ctx.repo}/actions`)}`);
        return 0;
    }
    ctx.print(`▶️  Started: ${s.link(started.url)}`);
    if (!options.wait)
        return 0;
    const follow = async (seen) => {
        await options.sleep(options.pollMs ?? 10_000);
        const [run, jobs] = await Promise.all([client.run(started.id), client.jobs(started.id)]);
        const changed = jobs.filter((job) => seen.get(job.name) !== (job.conclusion ?? job.status));
        changed.forEach((job) => ctx.print(jobLine(job, s)));
        const next = new Map(jobs.map((job) => [job.name, job.conclusion ?? job.status]));
        if (run.status !== 'completed')
            return follow(next);
        ctx.print(run.conclusion === 'success' ? shipped : `💥 ${s.bad(`Deploy ${run.conclusion ?? 'ended'}:`)} ${s.link(run.url)}`);
        return run.conclusion === 'success' ? 0 : 1;
    };
    return follow(new Map());
}
const wasLive = (deployment) => deployment.state === 'success' || deployment.state === 'inactive';
// The commit to roll back to: the one asked for (a SHA or a prefix of 7+ characters), or the newest
// one that was live before the live one. It must have been live on this environment.
function rollbackTarget(deployments, live, env, to) {
    const candidates = deployments.filter(wasLive).map((d) => d.sha).filter((sha) => sha !== live);
    if (!to) {
        const [newest] = candidates;
        if (newest)
            return newest;
        throw new Error(`No earlier deploy of ${env} to roll back to.`);
    }
    if (to.length < 7)
        throw new Error(`--to needs at least 7 characters of the SHA (got '${to}').`);
    if (live.startsWith(to))
        throw new Error(`${short(live)} is already live on ${env}.`);
    const match = candidates.find((sha) => sha.startsWith(to));
    if (match)
        return match;
    throw new Error(`${to} was never live on ${env} in its recent deploys, so it can't be a rollback target. See ship log.`);
}
function missingRollbackWorkflow(workflow) {
    return [
        `This repo has no .github/workflows/${workflow} to roll back with (GitHub says it doesn't exist). Add it:`,
        '',
        'name: Ship rollback',
        'on:',
        '  workflow_dispatch:',
        '    inputs:',
        '      environment: { description: Environment to roll back, required: true, type: string }',
        '      sha: { description: Commit to deploy, required: true, type: string }',
        'jobs:',
        '  rollback:',
        '    permissions: { contents: read, checks: read, deployments: write }',
        '    uses: ideaSquared/shipper/.github/workflows/deploy.yml@v1',
        '    with:',
        '      environment: ${{ inputs.environment }}',
        '      sha: ${{ inputs.sha }}',
        '      rollback: true',
        '    secrets: inherit',
    ].join('\n');
}
export async function rollback(ctx, environment, options) {
    const { client, manifest, style: s } = ctx;
    const env = pickEnvironment(manifest, environment);
    if (!ctx.canWrite)
        throw new Error('Rolling back needs a GitHub token. Run `gh auth login` or set GH_TOKEN.');
    const [live, deployments] = await Promise.all([client.lastSuccessfulDeployment(env), client.deployments(env, 50)]);
    if (!live)
        throw new Error(`${env} has never been deployed, so there is nothing to roll back.`);
    const target = rollbackTarget(deployments, live, env, options.to);
    const comparison = await client.compare(target, live).catch((error) => {
        ctx.print(`⚠️  ${s.warn(`Could not list the commits being taken out: ${error instanceof Error ? error.message : String(error)}`)}`);
        return undefined;
    });
    ctx.print(`⏪ live ${s.sha(short(live))} → ${s.sha(short(target))}${comparison ? ` · ${s.warn(`${comparison.totalCommits} commits taken out`)}` : ''}`);
    if (comparison)
        printCommits(ctx, comparison.commits, comparison.totalCommits, 10);
    if (!options.yes && !(await options.confirm(`⏪ Roll ${s.env(env)} back to ${s.sha(short(target))}?`))) {
        ctx.print(`🙅 ${s.dim('Not rolled back.')}`);
        return 1;
    }
    const workflow = manifest.dispatch?.rollbackWorkflow ?? DEFAULT_ROLLBACK_WORKFLOW;
    const since = options.now();
    await client.dispatchWorkflow(workflow, ctx.defaultBranch, { environment: env, sha: target }).catch((error) => {
        if (error instanceof GitHubApiError && error.status === 404)
            throw new Error(missingRollbackWorkflow(workflow));
        throw error;
    });
    return followRun(ctx, workflow, since, options, `⏪ ${s.ok(`Rolled ${env} back to ${short(target)}.`)}`);
}
