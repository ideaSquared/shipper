// What `ship status | diff | log | deploy` do. The CLI wires in GitHub, the terminal and the clock.
import { evaluateGate } from "./gate.js";
import { parseManifest } from "./manifest.js";
const short = (sha) => sha.slice(0, 7);
export async function loadContext(client, repo, print, canWrite, timeZone) {
    const defaultBranch = await client.defaultBranch();
    const [head, text] = await Promise.all([client.headSha(defaultBranch), client.readFile('ship.yaml', defaultBranch)]);
    if (text === undefined)
        throw new Error(`${repo} has no ship.yaml on ${defaultBranch}, so it doesn't deploy with shipper yet.`);
    return { client, repo, manifest: parseManifest(text), defaultBranch, head, print, canWrite, timeZone };
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
    const { client, manifest, head } = ctx;
    ctx.print(`${manifest.product} (${ctx.repo}) · ${ctx.defaultBranch} is at ${short(head)}`);
    const rows = await Promise.all(Object.keys(manifest.environments).map(async (env) => {
        const [latest] = (await client.deployments(env, 20)).filter((d) => d.state === 'success' || d.state === 'inactive');
        if (!latest)
            return `  ${env.padEnd(12)} never deployed`;
        const behind = latest.sha === head ? 'up to date' : `${(await client.compare(latest.sha, head)).totalCommits} commits behind`;
        return `  ${env.padEnd(12)} ${short(latest.sha)}  ${formatTime(latest.createdAt, ctx.timeZone)}  ${latest.creator}  ${behind}`;
    }));
    rows.forEach((row) => ctx.print(row));
    return 0;
}
function printCommits(ctx, commits, total, max) {
    const newest = [...commits].reverse().slice(0, max);
    newest.forEach((c) => ctx.print(`  ${short(c.sha)} ${c.message} · ${c.author}`));
    if (total > newest.length)
        ctx.print(`  …and ${total - newest.length} more`);
}
export async function diff(ctx, environment) {
    const env = pickEnvironment(ctx.manifest, environment);
    const live = await ctx.client.lastSuccessfulDeployment(env);
    if (!live) {
        ctx.print(`${env} has never been deployed. ${ctx.defaultBranch} is at ${short(ctx.head)}.`);
        return 0;
    }
    if (live === ctx.head) {
        ctx.print(`${env} is up to date at ${short(live)}.`);
        return 0;
    }
    const comparison = await ctx.client.compare(live, ctx.head);
    ctx.print(`${env}: ${short(live)} → ${short(ctx.head)} · ${comparison.totalCommits} commits waiting`);
    printCommits(ctx, comparison.commits, comparison.totalCommits, 50);
    ctx.print(`  ${comparison.url}`);
    return 0;
}
export async function log(ctx, environment, limit) {
    const env = pickEnvironment(ctx.manifest, environment);
    const deployments = await ctx.client.deployments(env, limit);
    if (deployments.length === 0)
        ctx.print(`No deployments to ${env} yet.`);
    deployments.forEach((d) => ctx.print(`  ${formatTime(d.createdAt, ctx.timeZone)}  ${short(d.sha)}  ${d.state.padEnd(11)} ${d.creator}`));
    return 0;
}
const jobLine = (job) => `  ${job.name}: ${job.conclusion ?? job.status}`;
export async function deploy(ctx, environment, options) {
    const { client, manifest, head } = ctx;
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
    const gate = evaluateGate(manifest, env, {
        sha: head,
        defaultBranch: ctx.defaultBranch,
        onDefaultBranch: true,
        checkRuns,
        deployedTo,
    });
    if (!gate.ok) {
        ctx.print(`Can't ship ${short(head)} to ${env}:`);
        gate.failures.forEach((failure) => ctx.print(`  • ${failure}`));
        return 1;
    }
    if (live === head && !options.redeploy) {
        ctx.print(`${short(head)} is already live on ${env}. Nothing to ship (use --redeploy to deploy it again).`);
        return 0;
    }
    if (live && live !== head) {
        const comparison = await client.compare(live, head);
        ctx.print(`${short(live)} → ${short(head)} · ${comparison.totalCommits} commits`);
        printCommits(ctx, comparison.commits, comparison.totalCommits, 10);
    }
    else if (!live) {
        ctx.print(`First ship to ${env}: ${short(head)}`);
    }
    if (!options.yes && !(await options.confirm(`Ship ${short(head)} to ${env}?`))) {
        ctx.print('Not shipped.');
        return 1;
    }
    const { workflow, environmentInput } = manifest.dispatch;
    const since = options.now();
    await client.dispatchWorkflow(workflow, ctx.defaultBranch, environmentInput ? { [environmentInput]: env } : {});
    const findRun = async (attempt) => {
        const run = await client.findDispatchedRun(workflow, since);
        if (run || attempt >= (options.findRunAttempts ?? 20))
            return run;
        await options.sleep(3000);
        return findRun(attempt + 1);
    };
    const started = await findRun(1);
    if (!started) {
        ctx.print(`Started, but the run hasn't appeared yet. Check https://github.com/${ctx.repo}/actions`);
        return 0;
    }
    ctx.print(`Started: ${started.url}`);
    if (!options.wait)
        return 0;
    const follow = async (seen) => {
        await options.sleep(options.pollMs ?? 10_000);
        const [run, jobs] = await Promise.all([client.run(started.id), client.jobs(started.id)]);
        const changed = jobs.filter((job) => seen.get(job.name) !== (job.conclusion ?? job.status));
        changed.forEach((job) => ctx.print(jobLine(job)));
        const next = new Map(jobs.map((job) => [job.name, job.conclusion ?? job.status]));
        if (run.status !== 'completed')
            return follow(next);
        ctx.print(run.conclusion === 'success' ? `Shipped ${short(head)} to ${env}.` : `Deploy ${run.conclusion ?? 'ended'}: ${run.url}`);
        return run.conclusion === 'success' ? 0 : 1;
    };
    return follow(new Map());
}
