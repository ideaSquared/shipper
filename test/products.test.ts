import { describe, expect, it } from 'vitest';
import { accessHint, activeProducts, assertShippable, ownerFromCodeowners, parseTarget, productForRepo, repoFromRemote, resolveRepo } from '../src/products.ts';

describe('repoFromRemote', () => {
  it('reads https and ssh GitHub remotes', () => {
    expect(repoFromRemote('https://github.com/ideaSquared/gaminginit-bot.git')).toBe('ideaSquared/gaminginit-bot');
    expect(repoFromRemote('git@github.com:ideaSquared/shipper.git')).toBe('ideaSquared/shipper');
    expect(repoFromRemote('https://github.com/ideaSquared/shipper')).toBe('ideaSquared/shipper');
    expect(repoFromRemote('https://gitlab.com/x/y.git')).toBeUndefined();
  });
});

describe('resolveRepo', () => {
  it('prefers --repo, then a product name, then the folder remote', () => {
    expect(resolveRepo({ repo: 'a/b', product: 'gaminginit-bot' })).toBe('a/b');
    expect(resolveRepo({ product: 'gaminginit-bot', remote: 'https://github.com/x/y' })).toBe('ideaSquared/gaminginit-bot');
    expect(resolveRepo({ remote: 'https://github.com/x/y.git' })).toBe('x/y');
  });

  it('knows agent-idea', () => {
    expect(resolveRepo({ product: 'agent-idea' })).toBe('ideaSquared/agent-idea');
  });

  it('explains what to do when it cannot tell', () => {
    expect(() => resolveRepo({ product: 'nope' })).toThrow("Unknown product 'nope'");
    expect(() => resolveRepo({})).toThrow('Which product?');
  });
});

describe('parseTarget', () => {
  it('finds the product and environment in either order', () => {
    expect(parseTarget(['production', 'ads'])).toEqual({ product: 'ads', environment: 'production' });
    expect(parseTarget(['ads', 'production'])).toEqual({ product: 'ads', environment: 'production' });
    expect(parseTarget(['staging'])).toEqual({ product: undefined, environment: 'staging' });
    expect(parseTarget(['creatrgrid'])).toEqual({ product: 'creatrgrid', environment: undefined });
    expect(parseTarget([])).toEqual({ product: undefined, environment: undefined });
  });
});

describe('retired products', () => {
  it('keeps a retired product resolvable for read-only commands', () => {
    expect(resolveRepo({ product: 'gaminginit' })).toBe('ideaSquared/gaminginit');
  });

  it('leaves retired products out of the active list', () => {
    expect(activeProducts()).not.toHaveProperty('gaminginit');
    expect(activeProducts()).toHaveProperty('gaminginit-bot', 'ideaSquared/gaminginit-bot');
  });

  it('refuses to deploy or roll back a retired product, saying why', () => {
    expect(() => assertShippable('gaminginit')).toThrow(/gaminginit is retired \(.+\)\. Nothing to ship\./);
    expect(() => assertShippable('gaminginit-bot')).not.toThrow();
    expect(() => assertShippable(undefined)).not.toThrow();
  });

  it('still finds a retired product named on the command line', () => {
    expect(parseTarget(['gaminginit', 'production'])).toEqual({ product: 'gaminginit', environment: 'production' });
  });
});

describe('owners from CODEOWNERS', () => {
  it('takes the first owner on the catch-all line, skipping comments and other paths', () => {
    const text = [
      '# Today each product has a single owning team.',
      '',
      '/docs/ @ideaSquared/docs',
      '* @ideaSquared/creatrgrid @someone',
      '/src/ @ideaSquared/creatrgrid',
    ].join('\n');
    expect(ownerFromCodeowners(text)).toBe('@ideaSquared/creatrgrid');
  });

  it('finds no owner without a catch-all line', () => {
    expect(ownerFromCodeowners('/src/ @ideaSquared/x\n')).toBeUndefined();
  });

  it('names the owner in the access hint, or points to an org admin when unknown', () => {
    expect(accessHint('ideaSquared/creatrgrid', '@ideaSquared/creatrgrid')).toBe(
      "You may not have access to ideaSquared/creatrgrid. It's owned by @ideaSquared/creatrgrid: ask them for write access.",
    );
    expect(accessHint('ideaSquared/creatrgrid', undefined)).toContain('Ask a GitHub org admin');
  });
});

describe('productForRepo', () => {
  it('finds the product a repo belongs to, ignoring case, so a retired one is caught from its folder', () => {
    expect(productForRepo('ideasquared/GamingInit')).toBe('gaminginit');
    expect(() => assertShippable(productForRepo('ideaSquared/gaminginit'))).toThrow('gaminginit is retired');
    expect(productForRepo('someone/else')).toBeUndefined();
  });
});
