// `ship freeze` / `ship unfreeze`: block deploys to a product during an incident or release window.
// The state is one Actions repository variable on the product repo, so it is visible to the CLI
// (through the REST API) and to the workflow (through the `vars` context, which in a reusable
// workflow is the caller repo's variables) without any extra permission.
import { z } from 'zod';
export const FREEZE_VARIABLE = 'SHIP_FREEZE';
const FreezeSchema = z.strictObject({
    // Environments that refuse deploys, or "all" for every environment the product has.
    environments: z.union([z.literal('all'), z.array(z.string().min(1)).min(1)]),
    reason: z.string().min(1),
    // GitHub login of whoever set it.
    by: z.string().min(1),
    // ISO time it was set.
    at: z.string().min(1),
});
export function parseFreeze(text) {
    try {
        return FreezeSchema.parse(JSON.parse(text));
    }
    catch {
        // Not echoing the value: it is shown to people elsewhere, and a bad one is the thing to fix.
        throw new Error(`${FREEZE_VARIABLE} is not a valid freeze. Run \`ship unfreeze\` and freeze again.`);
    }
}
export const isFrozen = (freeze, environment) => freeze !== undefined && (freeze.environments === 'all' || freeze.environments.includes(environment));
const scope = (freeze) => (freeze.environments === 'all' ? 'all environments' : freeze.environments.join(', '));
// Why an environment can't be deployed to, or undefined when it can.
export function freezeFailure(freeze, environment, product) {
    if (!isFrozen(freeze, environment))
        return undefined;
    const lift = product ? `ship unfreeze ${product} ${environment}` : 'ship unfreeze';
    return `${environment} is frozen by ${freeze.by} since ${freeze.at}: ${freeze.reason}. Lift it with ${lift} when it is safe.`;
}
// The workflow's view: the value of `vars.SHIP_FREEZE` (an empty string when it is not set).
// A value that can't be read blocks the deploy rather than letting it through.
export function freezeFromVariable(value) {
    if (!value?.trim())
        return {};
    try {
        return { freeze: parseFreeze(value) };
    }
    catch (error) {
        return { failure: error instanceof Error ? error.message : String(error) };
    }
}
export async function readFreeze(client) {
    const value = await client.readVariable(FREEZE_VARIABLE);
    return value === undefined ? undefined : parseFreeze(value);
}
// The freeze as lines for the terminal.
export function describeFreeze(ctx, freeze) {
    const s = ctx.style;
    const at = Number.isNaN(Date.parse(freeze.at))
        ? freeze.at
        : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: ctx.timeZone }).format(new Date(freeze.at));
    return [`❄️  ${s.warn('frozen')}: ${scope(freeze)}`, `   ${freeze.reason}`, `   ${s.dim(`by ${freeze.by} · ${at}`)}`];
}
const allEnvironments = (ctx) => Object.keys(ctx.manifest.environments);
function checkEnvironment(ctx, environment) {
    const names = allEnvironments(ctx);
    if (environment && !names.includes(environment)) {
        throw new Error(`No environment '${environment}' in ship.yaml. It has: ${names.join(', ')}.`);
    }
}
// Freezing more is additive: an existing freeze on other environments stays.
function widen(existing, environment, all) {
    if (!environment || existing?.environments === 'all')
        return 'all';
    const merged = [...new Set([...(existing?.environments ?? []), environment])];
    return all.every((name) => merged.includes(name)) ? 'all' : merged;
}
export async function freeze(ctx, environment, options) {
    const { client, style: s } = ctx;
    if (!ctx.canWrite)
        throw new Error('Freezing needs a GitHub token. Run `gh auth login` or set GH_TOKEN.');
    if (!options.reason?.trim())
        throw new Error('A freeze needs a reason everyone can see: --reason "…".');
    checkEnvironment(ctx, environment);
    const existing = await readFreeze(client);
    if (existing)
        describeFreeze(ctx, existing).forEach((line) => ctx.print(line));
    const target = widen(existing, environment, allEnvironments(ctx));
    const label = target === 'all' ? 'every environment' : target.join(', ');
    if (!options.yes && !(await options.confirm(`❄️  Freeze deploys to ${s.env(label)} of ${ctx.manifest.product}?`))) {
        ctx.print(`🙅 ${s.dim('Not frozen.')}`);
        return 1;
    }
    // Re-read after the prompt, which can wait a long time, so a change someone made meanwhile is kept.
    // GitHub variables have no compare-and-set, so this narrows the race to a moment; it can't close it.
    const current = widen(await readFreeze(client), environment, allEnvironments(ctx));
    const next = { environments: current, reason: options.reason.trim(), by: await client.currentUser(), at: options.now().toISOString() };
    await client.writeVariable(FREEZE_VARIABLE, JSON.stringify(next));
    ctx.print(`❄️  ${s.warn(`Deploys to ${current === 'all' ? 'every environment' : current.join(', ')} are frozen.`)} Lift it with ship unfreeze.`);
    return 0;
}
export async function unfreeze(ctx, environment, options) {
    const { client, style: s } = ctx;
    if (!ctx.canWrite)
        throw new Error('Unfreezing needs a GitHub token. Run `gh auth login` or set GH_TOKEN.');
    checkEnvironment(ctx, environment);
    // A malformed value blocks every deploy, so a plain `ship unfreeze` must be able to remove it.
    // Lifting one environment needs a readable freeze, to know what stays frozen.
    const read = await readFreeze(client).then((freeze) => ({ freeze, malformed: false }), (error) => {
        if (environment || !(error instanceof Error) || !error.message.startsWith(FREEZE_VARIABLE))
            throw error;
        return { freeze: undefined, malformed: true };
    });
    const existing = read.freeze;
    if (!read.malformed && (!existing || (environment && !isFrozen(existing, environment)))) {
        ctx.print(`✅ ${environment ? `${s.env(environment)} is` : `${ctx.manifest.product} is`} ${s.ok('not frozen')}.`);
        return 0;
    }
    if (existing)
        describeFreeze(ctx, existing).forEach((line) => ctx.print(line));
    else
        ctx.print(`⚠️  ${s.warn(`${FREEZE_VARIABLE} is not a valid freeze, so it blocks every deploy. Lifting it removes it.`)}`);
    const label = environment ?? 'every environment';
    if (!options.yes && !(await options.confirm(`🔓 Lift the freeze on ${s.env(label)}?`))) {
        ctx.print(`🙅 ${s.dim('Still frozen.')}`);
        return 1;
    }
    if (!environment) {
        await client.deleteVariable(FREEZE_VARIABLE);
    }
    else {
        // Re-read after the prompt so a freeze someone added meanwhile is kept (see freeze()).
        const latest = await readFreeze(client);
        // Lifting one environment keeps the rest frozen, including out of an "all" freeze.
        const remaining = latest
            ? (latest.environments === 'all' ? allEnvironments(ctx) : latest.environments).filter((name) => name !== environment)
            : [];
        if (latest && remaining.length > 0)
            await client.writeVariable(FREEZE_VARIABLE, JSON.stringify({ ...latest, environments: remaining }));
        else if (latest)
            await client.deleteVariable(FREEZE_VARIABLE);
    }
    ctx.print(`🔓 ${s.ok(`Deploys to ${label} are open again.`)}`);
    return 0;
}
