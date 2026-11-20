// The smoke checks ship.yaml lists for one environment, each normalised to { url, expect? }.
export function smokeFor(manifest, environment) {
    return (manifest.smoke?.[environment] ?? []).map((check) => (typeof check === 'string' ? { url: check } : check));
}
// One request, no body ever leaves this function: the detail names the status or that `expect` was missing.
async function attemptOnce(check, options) {
    const response = await options.fetch(check.url, { redirect: 'follow', signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
    if (!response.ok)
        return `HTTP ${response.status}`;
    if (!check.expect)
        return undefined;
    const body = await response.text();
    return body.includes(check.expect) ? undefined : `HTTP ${response.status} but the expected text was missing`;
}
export async function smokeOne(check, options) {
    const attempts = options.attempts ?? 3;
    const attempt = async (n) => {
        const failure = await attemptOnce(check, options).catch((error) => (error instanceof Error ? error.message : String(error)) || 'request failed');
        if (failure === undefined)
            return { url: check.url, ok: true, detail: check.expect ? 'answered, expected text present' : 'answered' };
        if (n >= attempts)
            return { url: check.url, ok: false, detail: `${failure} (${attempts} attempts)` };
        await options.sleep(options.intervalMs ?? 5000);
        return attempt(n + 1);
    };
    return attempt(1);
}
// Requests every smoke URL for the environment once (with retries). Empty when ship.yaml lists none.
export async function runSmoke(manifest, environment, options) {
    return Promise.all(smokeFor(manifest, environment).map((check) => smokeOne(check, options)));
}
// Appends a failed `smoke` pseudo-component when a check failed, so the job summary and the Discord
// report show a failed deploy. A smoke failure never rolls back: it can come from a dependency.
export function smokeComponent(manifest, environment, results) {
    const failed = results.filter((result) => !result.ok);
    if (failed.length === 0)
        return undefined;
    const lines = failed.map((result) => `${result.url}: ${result.detail}`).join('; ');
    return {
        name: 'smoke',
        status: 'failed',
        detail: `smoke check failed: ${lines}. Not rolled back; if the release is at fault run \`ship rollback ${manifest.product} ${environment}\``,
    };
}
// The smoke step of a Cloudflare deploy: runs only when every component deployed and passed its health check.
export async function smokeAfterDeploy(manifest, environment, deployed, options) {
    if (!deployed.every((result) => result.status === 'deployed'))
        return undefined;
    return smokeComponent(manifest, environment, await runSmoke(manifest, environment, options));
}
