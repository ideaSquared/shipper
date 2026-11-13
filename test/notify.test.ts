import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildReport, outcomeOf, sendReport, signBody, type ReportInput } from '../src/notify.ts';

const SHA = 'bbbbbbb1234567890bbbbbbb1234567890bbbbbb';
const PREV = 'aaaaaaa1234567890aaaaaaa1234567890aaaaaa';

const input: ReportInput = {
  project: 'gaminginit',
  product: 'gaminginit-bot',
  repository: 'ideaSquared/gaminginit-bot',
  environment: 'production',
  outcome: 'shipped',
  actor: 'octocat',
  at: new Date('2026-11-13T20:03:30Z'),
  sha: SHA,
  runUrl: 'https://github.com/ideaSquared/gaminginit-bot/actions/runs/1',
  previousSha: PREV,
  comparison: {
    totalCommits: 2,
    url: 'https://github.com/ideaSquared/gaminginit-bot/compare/aaaaaaa...bbbbbbb',
    commits: [
      { sha: '1111', message: 'older change', author: 'octocat', url: 'u1' },
      { sha: '2222', message: 'newer change', author: 'hubot', url: 'u2' },
    ],
  },
  components: [{ name: 'bot', status: 'deployed', url: 'https://bot.dev' }],
};

describe('outcomeOf', () => {
  it('calls it shipped only when every component deployed', () => {
    expect(outcomeOf([{ name: 'a', status: 'deployed' }])).toBe('shipped');
    expect(outcomeOf([{ name: 'a', status: 'rolled-back' }, { name: 'b', status: 'skipped' }])).toBe('rolled-back');
    expect(outcomeOf([{ name: 'a', status: 'deployed' }, { name: 'b', status: 'failed' }])).toBe('failed');
  });
});

describe('buildReport', () => {
  it('says who shipped what, from which commit to which, and when', () => {
    const report = buildReport(input);
    expect(report).toMatchObject({
      version: 1,
      project: 'gaminginit',
      outcome: 'shipped',
      actor: 'octocat',
      at: '2026-11-13T20:03:30.000Z',
      sha: SHA,
      previousSha: PREV,
      totalCommits: 2,
      compareUrl: 'https://github.com/ideaSquared/gaminginit-bot/compare/aaaaaaa...bbbbbbb',
    });
    expect(report.commits.map((commit) => commit.message)).toEqual(['newer change', 'older change']);
  });

  it('lists at most ten commits but keeps the true total', () => {
    const commits = Array.from({ length: 25 }, (_, i) => ({ sha: `${i}`, message: `c${i}`, author: 'a', url: 'u' }));
    const report = buildReport({ ...input, comparison: { totalCommits: 25, url: 'u', commits } });
    expect(report.commits).toHaveLength(10);
    expect(report.commits[0]?.message).toBe('c24');
    expect(report.totalCommits).toBe(25);
  });

  it('handles a first deploy with no earlier commit', () => {
    const { previousSha, comparison, ...first } = input;
    const report = buildReport(first);
    expect(report).toMatchObject({ previousSha: null, compareUrl: null, totalCommits: 0, commits: [] });
  });
});

describe('sendReport', () => {
  it('signs the exact body it sends', async () => {
    const seen: { body: string; signature: string | null }[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const headers = new Headers(init?.headers);
      seen.push({ body: String(init?.body), signature: headers.get('x-ship-signature-256') });
      return new Response('ok');
    };
    expect(await sendReport('https://bot.dev/ship', 's3cret', buildReport(input), fetchImpl)).toEqual({
      ok: true,
      detail: 'Discord message sent',
    });
    const expected = `sha256=${createHmac('sha256', 's3cret').update(seen[0]?.body ?? '').digest('hex')}`;
    expect(seen[0]?.signature).toBe(expected);
    expect(signBody('s3cret', seen[0]?.body ?? '')).toBe(expected);
  });

  it('reports a refused or unreachable bot without throwing', async () => {
    const refused: typeof fetch = async () => new Response('Invalid signature', { status: 401 });
    expect(await sendReport('https://bot.dev/ship', 's', buildReport(input), refused)).toEqual({
      ok: false,
      detail: 'bot answered HTTP 401: Invalid signature',
    });
    const down: typeof fetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    expect((await sendReport('https://bot.dev/ship', 's', buildReport(input), down)).detail).toBe('getaddrinfo ENOTFOUND');
    const brokenBody: typeof fetch = async () => {
      const body = new ReadableStream({ start: (controller) => controller.error(new Error('connection reset')) });
      return new Response(body, { status: 502 });
    };
    expect(await sendReport('https://bot.dev/ship', 's', buildReport(input), brokenBody)).toEqual({
      ok: false,
      detail: 'bot answered HTTP 502: ',
    });
  });
});
