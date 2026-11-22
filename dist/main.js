// Entry point the reusable workflow runs: `node src/main.ts <gate|deploy> <environment>`.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { deployComponents, renderSummary } from "./cloudflare.js";
import { freezeFailure, freezeFromVariable } from "./freeze.js";
import { evaluateGate, liveFailure } from "./gate.js";
import { createGitHubClient, GitHubApiError } from "./github.js";
import { environmentOf, parseManifest } from "./manifest.js";
import { runSmoke, smokeAfterDeploy, smokeComponent } from "./smoke.js";
import { formatDuration, waitForGate, waitingFor } from "./queue.js";
import { buildReport, outcomeOf, sendReport, shipActor } from "./notify.js";
const EnvSchema = z.object({
    SHIP_REPO_ROOT: z.string().min(1),
    GITHUB_REPOSITORY: z.string().min(1),
    // The commit to deploy: the workflow's `sha` input, or the run's own commit.
    SHIP_SHA: z.string().min(1),
    // `rollback: true`: put back a commit that was live before, even though it is older than what is live.
    SHIP_ROLLBACK: z
        .enum(['true', 'false'])
        .default('false')
        .transform((value) => value === 'true'),
    GITHUB_ACTOR: z.string().default('unknown'),
    // The event that started the caller's workflow: `push` for an automatic deploy, `workflow_dispatch` for `ship`.
    GITHUB_EVENT_NAME: z.string().optional(),
    GITHUB_STEP_SUMMARY: z.string().optional(),
    GITHUB_SERVER_URL: z.string().default('https://github.com'),
    GITHUB_RUN_ID: z.string().default(''),
    GITHUB_TOKEN: z.string().min(1),
    // `vars.SHIP_FREEZE` of the calling repo, set by `ship freeze`. Empty or missing when not frozen.
    SHIP_FREEZE: z.string().optional(),
    SHIP_NOTIFY_URL: z.string().optional(),
    SHIP_NOTIFY_SECRET: z.string().optional(),
});
// Streams the command's output to the job log and also returns it.
const run = (command, args, cwd, extraEnv = {}) => new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    const collect = (stream) => (chunk) => {
        chunks.push(chunk.toString());
        stream.write(chunk);
    };
    child.stdout.on('data', collect(process.stdout));
    child.stderr.on('data', collect(process.stderr));
    child.on('error', (error) => resolve({ code: 1, output: error.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, output: chunks.join('') }));
});
// GitHub workflow commands end at a newline, so encode them.
const sentence = (text) => (text.endsWith('.') ? text : `${text}.`);
function annotate(title, message, level = 'error') {
    const encode = (text) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.log(`::${level} title=${encode(title)}::${encode(message)}`);
}
const actorOf = (env) => shipActor(env.GITHUB_EVENT_NAME, env.GITHUB_ACTOR);
const runUrlOf = (env) => `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
// Sends the deploy message to Discord through the ideaSquared bot. Only ever warns.
async function notify(env, manifest, input) {
    if (!manifest.discord) {
        annotate('Ship', 'No Discord message: ship.yaml has no discord project.', 'notice');
        return;
    }
    if (!env.SHIP_NOTIFY_URL || !env.SHIP_NOTIFY_SECRET) {
        annotate('Ship', 'No Discord message: SHIP_NOTIFY_SECRET is not set (pass secrets: inherit).', 'warning');
        return;
    }
    const report = buildReport({
        ...input,
        project: manifest.discord,
        product: manifest.product,
        repository: env.GITHUB_REPOSITORY,
        actor: actorOf(env),
        at: new Date(),
        sha: env.SHIP_SHA,
        runUrl: runUrlOf(env),
    });
    const sent = await sendReport(env.SHIP_NOTIFY_URL, env.SHIP_NOTIFY_SECRET, report);
    if (sent.ok)
        console.log(sent.detail);
    else
        annotate('Ship', `Discord message not sent: ${sent.detail}`, 'warning');
}
// What changed since the last successful deploy. Missing history only costs the commit list.
async function changesSince(github, previousSha, sha) {
    if (!previousSha)
        return undefined;
    return github.compare(previousSha, sha).catch((error) => {
        annotate('Ship', `Could not list commits since ${previousSha.slice(0, 7)}: ${String(error)}`, 'warning');
        return undefined;
    });
}
function loadManifest(repoRoot) {
    const path = join(repoRoot, 'ship.yaml');
    if (!existsSync(path))
        throw new Error('No ship.yaml at the repository root. See the shipper README for the format.');
    return parseManifest(readFileSync(path, 'utf8'));
}
function summarise(path, markdown) {
    if (path)
        appendFileSync(path, markdown);
}
// What is live in the environment and how `sha` relates to it. Unknown history never blocks a deploy.
async function liveFacts(github, environment, sha, live) {
    if (!live)
        return undefined;
    return github.relation(live, sha).then((relation) => ({ sha: live, relation }), (error) => {
        annotate('Ship', `Could not compare ${sha.slice(0, 7)} with the live ${live.slice(0, 7)}: ${String(error)}`, 'warning');
        return undefined;
    });
}
// Shipper records the Deployment itself (the deploy job sets `deployment: false`), so it names the
// commit really deployed rather than the run's own commit.
async function createDeployment(github, env, environment) {
    return github
        .createDeployment({ sha: env.SHIP_SHA, environment, actor: actorOf(env), production: environment === 'production' })
        .then((id) => ({ id }))
        .catch((error) => {
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof GitHubApiError && (error.status === 403 || error.status === 404)) {
            return { error: `Could not create a GitHub Deployment (${reason}). The job that calls shipper must grant \`permissions: deployments: write\`.` };
        }
        return { error: `Could not create a GitHub Deployment: ${reason}` };
    });
}
// Posts a Deployment status; returns false (after saying why) if GitHub did not take it.
async function recordStatus(github, id, status) {
    return github.setDeploymentStatus(id, status).then(() => true, (error) => {
        annotate('Ship', `Could not mark the GitHub Deployment ${status.state}: ${String(error)}`, status.state === 'in_progress' ? 'warning' : 'error');
        return false;
    });
}
async function gate(environment) {
    const env = EnvSchema.extend({
        DEFAULT_BRANCH: z.string().min(1),
        // How long a deploy blocked only by running checks (or a `requires` deploy under way) waits; 0 fails at once.
        SHIP_WAIT_MINUTES: z.coerce.number().min(0).default(0),
    }).parse(process.env);
    const manifest = loadManifest(env.SHIP_REPO_ROOT);
    const required = environmentOf(manifest, environment).requires;
    const github = createGitHubClient(env.GITHUB_REPOSITORY, env.GITHUB_TOKEN);
    const limitMs = env.SHIP_WAIT_MINUTES * 60_000;
    // A rollback target must have been live here before; a normal deploy must not be older than live.
    const deployedEnvironments = env.SHIP_ROLLBACK ? [...required, environment] : required;
    // Only worth asking when waiting is on: a `requires` environment without the commit yet may be deploying it.
    const deployingTo = async (deployedTo) => {
        const missing = required.filter((name) => !deployedTo.includes(name));
        return limitMs > 0 && missing.length > 0 ? github.deployingTo(env.SHIP_SHA, missing) : [];
    };
    const [onDefaultBranch, checkRuns, deployedTo, liveSha] = await Promise.all([
        github.isOnBranch(env.SHIP_SHA, env.DEFAULT_BRANCH),
        manifest.checks.length > 0 ? github.checkRuns(env.SHIP_SHA) : Promise.resolve([]),
        github.deployedTo(env.SHIP_SHA, deployedEnvironments),
        env.SHIP_ROLLBACK ? Promise.resolve(undefined) : github.lastSuccessfulDeployment(environment).catch(() => undefined),
    ]);
    // A rollback is never blocked by a freeze, not even by one that can't be read.
    const frozen = env.SHIP_ROLLBACK ? {} : freezeFromVariable(env.SHIP_FREEZE);
    const facts = {
        freeze: frozen.freeze,
        sha: env.SHIP_SHA,
        defaultBranch: env.DEFAULT_BRANCH,
        onDefaultBranch,
        checkRuns,
        deployedTo,
        deployingTo: await deployingTo(deployedTo),
        live: await liveFacts(github, environment, env.SHIP_SHA, liveSha),
        rollback: env.SHIP_ROLLBACK,
    };
    // An unreadable freeze is a failure waiting can't fix.
    const evaluate = (current) => {
        const gated = evaluateGate(manifest, environment, current);
        if (!frozen.failure)
            return gated;
        return { ...gated, ok: false, failures: [...gated.failures, frozen.failure], hard: [...gated.hard, frozen.failure] };
    };
    const first = evaluate(facts);
    // While waiting only the checks and the `requires` deploys can change. The branch and freeze can't, and
    // the deploy job checks again that the commit isn't older than what is live.
    const refresh = async () => {
        const [runs, deployed] = await Promise.all([
            first.waiting.length > 0 ? github.checkRuns(env.SHIP_SHA) : Promise.resolve(facts.checkRuns),
            first.deploying.length > 0 ? github.deployedTo(env.SHIP_SHA, deployedEnvironments) : Promise.resolve(facts.deployedTo),
        ]);
        return evaluate({ ...facts, checkRuns: runs, deployedTo: deployed, deployingTo: await deployingTo(deployed) });
    };
    const outcome = await waitForGate(first, 
    // Running out of API calls is not the commit's fault: wait and look again, still within the time limit.
    () => refresh().catch((error) => {
        if (!(error instanceof GitHubApiError && error.rateLimited))
            throw error;
        annotate('Ship gate', 'GitHub API rate limit reached while waiting. Looking again shortly.', 'warning');
        return first;
    }), {
        limitMs,
        now: () => Date.now(),
        sleep: (ms) => sleep(ms),
        onWait: (waiting, elapsedMs) => console.log(`Waiting for ${waitingFor(waiting.checks, waiting.deploying)} · ${formatDuration(elapsedMs)} of ${formatDuration(limitMs)}`),
    });
    if (outcome.action === 'proceed') {
        console.log(`Gate passed: ${env.SHIP_SHA.slice(0, 7)} can deploy to ${environment}.`);
        return 0;
    }
    outcome.failures.forEach((failure) => annotate('Ship gate', failure));
    summarise(env.GITHUB_STEP_SUMMARY, [`### Ship blocked for ${environment}`, '', ...outcome.failures.map((f) => `- ${f}`), ''].join('\n'));
    await notify(env, manifest, { environment, outcome: 'blocked', failures: outcome.failures });
    return 1;
}
async function deploy(environment) {
    const env = EnvSchema.parse(process.env);
    const manifest = loadManifest(env.SHIP_REPO_ROOT);
    const github = createGitHubClient(env.GITHUB_REPOSITORY, env.GITHUB_TOKEN);
    const missing = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'].filter((name) => !process.env[name]);
    if (missing.length > 0) {
        const message = `${missing.join(' and ')} not set. Add them to the '${environment}' GitHub Environment or the repo secrets, and pass secrets: inherit.`;
        annotate('Ship', message);
        await notify(env, manifest, { environment, outcome: 'failed', failures: [message] });
        return 1;
    }
    // Read before deploying: once this deploy succeeds, it becomes the newest successful one.
    const previousSha = await github.lastSuccessfulDeployment(environment).catch((error) => {
        annotate('Ship', `Could not read the last deploy to ${environment}: ${String(error)}`, 'warning');
        return undefined;
    });
    // A freeze set while this run waited (for approval or its turn) still stops it. A rollback never is.
    const frozen = env.SHIP_ROLLBACK ? {} : freezeFromVariable(env.SHIP_FREEZE);
    const frozenFailure = frozen.failure ?? freezeFailure(frozen.freeze, environment, manifest.product);
    if (frozenFailure) {
        annotate('Ship', sentence(frozenFailure));
        summarise(env.GITHUB_STEP_SUMMARY, `### Ship blocked for ${environment}\n\n- ${frozenFailure}\n`);
        await notify(env, manifest, { environment, outcome: 'blocked', failures: [frozenFailure] });
        return 1;
    }
    // Checked again here, inside the one-deploy-at-a-time job: a newer commit may have shipped while
    // this run waited, or this may be a re-run of an old run. A rollback instead re-checks its target was live.
    const blocked = liveFailure({
        product: manifest.product,
        sha: env.SHIP_SHA,
        rollback: env.SHIP_ROLLBACK,
        live: env.SHIP_ROLLBACK ? undefined : await liveFacts(github, environment, env.SHIP_SHA, previousSha),
        deployedTo: env.SHIP_ROLLBACK ? await github.deployedTo(env.SHIP_SHA, [environment]) : [],
    }, environment);
    if (blocked) {
        annotate('Ship', env.SHIP_ROLLBACK ? sentence(blocked) : `${sentence(blocked)} Not deploying an older commit over a newer one.`);
        summarise(env.GITHUB_STEP_SUMMARY, `### Ship blocked for ${environment}\n\n- ${blocked}\n`);
        await notify(env, manifest, { environment, outcome: 'blocked', failures: [blocked] });
        return 1;
    }
    const created = await createDeployment(github, env, environment);
    if ('error' in created) {
        annotate('Ship', created.error);
        await notify(env, manifest, { environment, outcome: 'failed', failures: [created.error] });
        return 1;
    }
    const deployment = created.id;
    const logUrl = runUrlOf(env);
    await recordStatus(github, deployment, { state: 'in_progress', logUrl });
    const deployed = await deployComponents({
        manifest,
        environment,
        sha: env.SHIP_SHA,
        actor: actorOf(env),
        repoRoot: env.SHIP_REPO_ROOT,
        run,
        fetch,
        sleep: (ms) => sleep(ms),
    }).catch(async (error) => {
        await recordStatus(github, deployment, { state: 'failure', logUrl });
        throw error;
    });
    // Only once every component deployed and passed its health check.
    const smoke = await smokeAfterDeploy(manifest, environment, deployed, { fetch, sleep: (ms) => sleep(ms) });
    const results = smoke ? [...deployed, smoke] : deployed;
    results.forEach((result) => console.log([`${result.name}: ${result.status}`, result.url, result.detail].filter(Boolean).join(' · ')));
    summarise(env.GITHUB_STEP_SUMMARY, renderSummary(environment, env.SHIP_SHA, results));
    results
        .filter((result) => result.status === 'failed' || result.status === 'rolled-back')
        .forEach((result) => annotate(`Ship ${result.name}`, result.detail ?? result.status));
    const shipped = results.every((result) => result.status === 'deployed');
    // GitHub's record is what the gate reads next time (requires, stale checks), so failing to write it fails the job.
    // A smoke failure is `error`, not `failure`: the release is live (nothing rolled back), so `ship rollback`
    // must treat it as the running release, while `requires` still refuses it (it isn't `success`).
    const status = shipped
        ? { state: 'success', logUrl, environmentUrl: results.find((result) => result.url)?.url }
        : { state: smoke ? 'error' : 'failure', logUrl };
    const recorded = await recordStatus(github, deployment, status);
    await notify(env, manifest, {
        environment,
        outcome: outcomeOf(results),
        previousSha,
        comparison: await changesSince(github, previousSha, env.SHIP_SHA),
        components: results,
    });
    return shipped && recorded ? 0 : 1;
}
// After a repo deployed with its own workflow (the gate.yml + report.yml path): sends the Discord
// message for the deploy job's result. Only ever warns: the deploy already happened.
async function report(environment) {
    const env = EnvSchema.extend({ SHIP_OUTCOME: z.string().default('failure') }).parse(process.env);
    const manifest = loadManifest(env.SHIP_REPO_ROOT);
    const github = createGitHubClient(env.GITHUB_REPOSITORY, env.GITHUB_TOKEN);
    const deployments = await github.deployments(environment, 30).catch((error) => {
        annotate('Ship', `Could not read the deploys to ${environment}: ${String(error)}`, 'warning');
        return [];
    });
    // Newest first, so the first live commit that isn't this one is what was live before.
    const previousSha = deployments.find((d) => (d.state === 'success' || d.state === 'inactive') && d.sha !== env.SHIP_SHA)?.sha;
    const deployedOk = env.SHIP_OUTCOME === 'success';
    const deployComponent = { name: 'deploy', status: deployedOk ? 'deployed' : 'failed', detail: `deploy job: ${env.SHIP_OUTCOME}` };
    // Smoke checks run only for a successful deploy, before reporting, so a failure shows as a failed deploy.
    const smoke = deployedOk ? smokeComponent(manifest, environment, await runSmoke(manifest, environment, { fetch, sleep: (ms) => sleep(ms) })) : undefined;
    if (smoke)
        annotate('Ship smoke', smoke.detail ?? 'smoke check failed');
    const components = smoke ? [deployComponent, smoke] : [deployComponent];
    summarise(env.GITHUB_STEP_SUMMARY, renderSummary(environment, env.SHIP_SHA, components));
    await notify(env, manifest, {
        environment,
        outcome: deployedOk && !smoke ? 'shipped' : 'failed',
        previousSha,
        comparison: await changesSince(github, previousSha, env.SHIP_SHA),
        components,
    });
    // The deploy already happened, so only a failed smoke check turns this job red.
    return smoke ? 1 : 0;
}
const COMMANDS = { gate, deploy, report };
const [command, environment] = process.argv.slice(2);
if (!command || !(command in COMMANDS) || !environment) {
    console.error('Usage: node src/main.ts <gate|deploy|report> <environment>');
    process.exit(2);
}
// The guard above has checked that `command` is a key of COMMANDS.
COMMANDS[command](environment).then((code) => process.exit(code), (error) => {
    annotate('Ship', error instanceof Error ? error.message : String(error));
    process.exit(1);
});
