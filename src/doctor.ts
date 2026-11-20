// What `ship doctor` does: checks a product's deploy setup before anyone deploys, so a setup
// mistake is found by a command rather than by a failed deploy. Read-only: GitHub's REST API plus
// plain HTTPS to the health URLs. Output is CLI output for people, so it uses the terminal.
import { DEFAULT_ROLLBACK_WORKFLOW } from './commands.ts';
import { isAccessError, type GitHubClient } from './github.ts';
import { healthFor, parseManifest, type Manifest } from './manifest.ts';
import { ownerFromCodeowners } from './products.ts';
import { plain, type Style } from './style.ts';

export type CheckResult = { level: 'pass' | 'warn' | 'fail'; message: string; fix?: string };

export type DoctorOptions = {
  // Only check this environment (repo-wide checks still run).
  environment?: string | undefined;
  print: (line: string) => void;
  style?: Style;
  fetch?: typeof fetch;
  healthTimeoutMs?: number;
};

const ICONS = { pass: '✅', warn: '⚠️ ', fail: '❌' } as const;
const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
const PRODUCTION = 'production';

const pass = (message: string): CheckResult => ({ level: 'pass', message });
const warn = (message: string, fix: string): CheckResult => ({ level: 'warn', message, fix });
const fail = (message: string, fix: string): CheckResult => ({ level: 'fail', message, fix });

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

// A check that could not even run (e.g. a GitHub error) is a failure, not a crash.
async function guard(label: string, run: () => Promise<CheckResult[]>): Promise<CheckResult[]> {
  try {
    return await run();
  } catch (error) {
    return [fail(`${label}: ${reason(error)}`, 'Check your GitHub sign-in and try again')];
  }
}

// A URL without its query or fragment, which could carry a token.
function display(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

function fetchFailure(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `timed out after ${Math.round(timeoutMs / 1000)}s`;
  }
  const code = error instanceof Error && error.cause instanceof Error && 'code' in error.cause ? String(error.cause.code) : '';
  if (/^(ENOTFOUND|EAI_AGAIN)/.test(code)) return `domain does not resolve (${code})`;
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return `bad TLS certificate (${code})`;
  // Never the raw message: fetch's errors can repeat the URL, credentials and query string included.
  return code ? `request failed (${code})` : 'request failed';
}

// Absolute https health URLs of the environment, once each. Relative paths have no domain to check.
function healthUrls(manifest: Manifest, environment: string): string[] {
  const urls = Object.values(manifest.components)
    .flatMap((component) => (component.type === 'cloudflare-worker' ? [healthFor(component, environment)?.url] : []))
    .filter((url): url is string => url !== undefined && URL.canParse(url) && new URL(url).protocol === 'https:');
  return [...new Set(urls)];
}

async function checkHealth(url: string, environment: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<CheckResult> {
  const label = `${environment} health ${display(url)}`;
  try {
    // Any HTTP status means the domain resolves and the TLS handshake worked.
    // `manual`: a redirect is itself an answer; following it would judge some other host.
    const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
    return pass(`${label} answers (${response.status})`);
  } catch (error) {
    return fail(`${label} unreachable: ${fetchFailure(error, timeoutMs)}`, 'Fix the DNS record or certificate, or the health URL in ship.yaml');
  }
}

async function checkWorkflow(client: GitHubClient, branch: string, file: string, role: string): Promise<CheckResult> {
  const found = await client.readFile(`.github/workflows/${file}`, branch);
  return found === undefined
    ? fail(`${role} workflow ${file} not found on ${branch}`, `Add .github/workflows/${file} or change dispatch in ship.yaml`)
    : pass(`${role} workflow ${file} exists`);
}

async function checkEnvironments(client: GitHubClient, manifest: Manifest, names: readonly string[]): Promise<CheckResult[]> {
  const listed = await client.environments().catch((error: unknown) => {
    if (isAccessError(error)) return undefined;
    throw error;
  });
  if (!listed) {
    return [warn("can't read environments: needs admin access", 'Ask a repo admin to run `ship doctor`, or check Settings → Environments by hand')];
  }
  return names.flatMap((name): CheckResult[] => {
    const environment = listed.find((candidate) => candidate.name === name);
    if (!environment) return [fail(`GitHub Environment '${name}' does not exist`, `Create it in Settings → Environments → New environment → ${name}`)];
    const wantsReviewers = name === PRODUCTION || (manifest.environments[name]?.requires.length ?? 0) > 0;
    if (!wantsReviewers) return [pass(`GitHub Environment '${name}' exists`)];
    return [
      pass(`GitHub Environment '${name}' exists`),
      environment.requiredReviewers
        ? pass(`'${name}' has required reviewers`)
        : warn(`'${name}' has no required reviewers`, `Add required reviewers in Settings → Environments → ${name}`),
    ];
  });
}

// GitHub uses the first CODEOWNERS it finds in this order and ignores the rest, as `ship` does.
async function checkCodeowners(client: GitHubClient, branch: string): Promise<CheckResult> {
  const files = await Promise.all(CODEOWNERS_PATHS.map((path) => client.readFile(path, branch)));
  const index = files.findIndex((text) => text !== undefined);
  const owner = index === -1 ? undefined : ownerFromCodeowners(files[index] ?? '');
  if (owner) return pass(`CODEOWNERS has a '*' line (${owner})`);
  const where = index === -1 ? 'No CODEOWNERS file' : `${CODEOWNERS_PATHS[index]} has no '*' line with an owner`;
  return warn(where, `Add \`* @org/team\` to ${CODEOWNERS_PATHS[index] ?? '.github/CODEOWNERS'} so \`ship\` can say who owns the product`);
}

async function checkRequiredChecks(client: GitHubClient, manifest: Manifest, head: string): Promise<CheckResult[]> {
  if (manifest.checks.length === 0) return [];
  const runs = await client.checkRuns(head);
  return manifest.checks.map((name) =>
    runs.some((run) => run.name === name)
      ? pass(`check '${name}' ran on ${head.slice(0, 7)}`)
      : fail(
          `check '${name}' not found on ${head.slice(0, 7)}`,
          `Match 'checks' in ship.yaml to a real check run name (seen: ${[...new Set(runs.map((run) => run.name))].join(', ') || 'none'})`,
        ),
  );
}

// Runs every check and prints one line each. Exit code 1 if any failed, else 0.
export async function doctor(client: GitHubClient, repo: string, options: DoctorOptions): Promise<number> {
  const { print, style: s = plain, environment, fetch: fetchImpl = fetch, healthTimeoutMs = 10_000 } = options;
  print(`🩺 ${s.bold('ship doctor')} ${s.dim(`(${repo})`)}`);

  const branch = await client.defaultBranch();
  const text = await client.readFile('ship.yaml', branch);
  const loaded = ((): { manifest: Manifest } | CheckResult => {
    if (text === undefined) return fail(`ship.yaml not found on ${branch}`, 'Add a ship.yaml to the default branch (see the shipper README)');
    try {
      return { manifest: parseManifest(text) };
    } catch (error) {
      return fail(reason(error), 'Fix ship.yaml and merge it to the default branch');
    }
  })();

  const results = await (async (): Promise<CheckResult[]> => {
    if (!('manifest' in loaded)) return [loaded];
    const { manifest } = loaded;
    const known = Object.keys(manifest.environments);
    if (environment && !known.includes(environment)) {
      return [pass(`ship.yaml on ${branch} parses`), fail(`environment '${environment}' is not in ship.yaml`, `Use one of: ${known.join(', ')}`)];
    }
    const names = environment ? [environment] : known;
    const head = await client.headSha(branch);
    const { dispatch } = manifest;
    const workflows = dispatch
      ? guard('workflows', () =>
          Promise.all([
            checkWorkflow(client, branch, dispatch.workflow, 'dispatch'),
            checkWorkflow(client, branch, dispatch.rollbackWorkflow ?? DEFAULT_ROLLBACK_WORKFLOW, 'rollback'),
          ]),
        )
      : Promise.resolve([]);
    const groups = await Promise.all([
      workflows,
      guard('environments', () => checkEnvironments(client, manifest, names)),
      guard('CODEOWNERS', async () => [await checkCodeowners(client, branch)]),
      guard('checks', () => checkRequiredChecks(client, manifest, head)),
      Promise.all(names.flatMap((name) => healthUrls(manifest, name).map((url) => checkHealth(url, name, fetchImpl, healthTimeoutMs)))),
    ]);
    return [pass(`ship.yaml on ${branch} parses`), ...groups.flat()];
  })();

  results.forEach(({ level, message, fix }) => {
    const paint = level === 'pass' ? s.ok : level === 'warn' ? s.warn : s.bad;
    print(`${ICONS[level]} ${level === 'pass' ? message : paint(message)}${fix ? s.dim(` · fix: ${fix}`) : ''}`);
  });
  const failures = results.filter((result) => result.level === 'fail').length;
  const warnings = results.filter((result) => result.level === 'warn').length;
  print(failures > 0 ? s.bad(`${failures} failed, ${warnings} warning${warnings === 1 ? '' : 's'}`) : `All good${warnings ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}`);
  return failures > 0 ? 1 : 0;
}
