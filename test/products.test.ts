import { describe, expect, it } from 'vitest';
import { parseTarget, repoFromRemote, resolveRepo } from '../src/products.ts';

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
