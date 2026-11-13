import { createHmac } from 'node:crypto';
const MAX_COMMITS = 10;
export function outcomeOf(results) {
    if (results.every((result) => result.status === 'deployed'))
        return 'shipped';
    if (results.some((result) => result.status === 'rolled-back'))
        return 'rolled-back';
    return 'failed';
}
export function buildReport(input) {
    return {
        version: 1,
        project: input.project,
        product: input.product,
        repository: input.repository,
        environment: input.environment,
        outcome: input.outcome,
        actor: input.actor,
        at: input.at.toISOString(),
        sha: input.sha,
        previousSha: input.previousSha ?? null,
        compareUrl: input.comparison?.url ?? null,
        runUrl: input.runUrl,
        totalCommits: input.comparison?.totalCommits ?? 0,
        // Newest first, like a changelog.
        commits: [...(input.comparison?.commits ?? [])].reverse().slice(0, MAX_COMMITS),
        components: input.components ?? [],
        failures: input.failures ?? [],
    };
}
export function signBody(secret, body) {
    return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}
// Posts the report. Never throws: a Discord message must not decide whether a deploy passed.
export async function sendReport(url, secret, report, fetchImpl = fetch) {
    const body = JSON.stringify(report);
    try {
        const response = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-ship-signature-256': signBody(secret, body) },
            body,
            signal: AbortSignal.timeout(10_000),
        });
        if (response.ok)
            return { ok: true, detail: 'Discord message sent' };
        const text = await response.text().catch(() => '');
        return { ok: false, detail: `bot answered HTTP ${response.status}: ${text.slice(0, 200)}` };
    }
    catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
}
