// Products deployed with shipper, so `ship <command> <product>` works from any folder.
// Add an entry when a repo starts using ship.yaml.
//
// Who owns a product isn't stored here: it's the team in the repo's own CODEOWNERS (see
// ownerFromCodeowners). Naming the owner grants nothing. Access is enforced by GitHub: the team
// needs write access to start the deploy workflow, and the repo's `production` environment should
// list the team as required reviewers.
export type Product = {
  repo: string;
  description: string;
  /** Set when the product is no longer shipped: why and when. Read-only commands still work. */
  retired?: string;
};

export const PRODUCTS: Readonly<Record<string, Product>> = {
  ads: {
    repo: 'ideaSquared/adopt-dont-shop',
    description: "Adopt Don't Shop, the pet adoption platform",
  },
  'agent-idea': {
    repo: 'ideaSquared/agent-idea',
    description: 'Agent Idea',
  },
  creatrgrid: {
    repo: 'ideaSquared/creatrgrid',
    description: 'CreatrGrid, auto-filled websites for creators',
  },
  gaminginit: {
    repo: 'ideaSquared/gaminginit',
    description: 'GamingInit website',
    retired: 'deprecated November 2026',
  },
  'gaminginit-bot': {
    repo: 'ideaSquared/gaminginit-bot',
    description: 'GamingInit Discord bot',
  },
  'ideasquared-bot': {
    repo: 'ideaSquared/ideasquared-bot',
    description: 'ideaSquared Discord bot: deploy messages and the live board',
  },
};

// Product name → repo for the products still shipped, e.g. for `ship status` across everything.
export function activeProducts(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(PRODUCTS)
      .filter(([, product]) => !product.retired)
      .map(([name, product]) => [name, product.repo]),
  );
}

// Deploys and rollbacks stop here for a retired product. `--repo` (no product name) bypasses this.
export function assertShippable(name: string | undefined): void {
  const retired = name ? PRODUCTS[name]?.retired : undefined;
  if (retired) throw new Error(`🪦 ${name} is retired (${retired}). Nothing to ship.`);
}

// The owning team: the first owner on the repo's catch-all `*` line in CODEOWNERS.
export function ownerFromCodeowners(text: string): string | undefined {
  const line = text
    .split('\n')
    .map((raw) => raw.trim())
    .find((raw) => /^\*\s/.test(raw));
  return line?.split(/\s+/).find((token) => token.startsWith('@'));
}

// What to tell someone GitHub just refused (403/404) for a repo, naming its owner when known.
// A private repo's CODEOWNERS can't be read without access, so the owner may be unknown.
export function accessHint(repo: string, owner: string | undefined): string {
  return owner
    ? `You may not have access to ${repo}. It's owned by ${owner}: ask them for write access.`
    : `You may not have access to ${repo}. Ask a GitHub org admin to add you to its team.`;
}

// owner/name from a GitHub remote URL (https or ssh), or undefined for anything else.
export function repoFromRemote(remote: string): string | undefined {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export type RepoChoice = { repo?: string; product?: string; remote?: string };

// --repo wins, then a product name, then the folder's git remote.
export function resolveRepo(choice: RepoChoice): string {
  if (choice.repo) return choice.repo;
  if (choice.product) {
    const product = PRODUCTS[choice.product];
    if (product) return product.repo;
    throw new Error(`Unknown product '${choice.product}'. Known: ${Object.keys(activeProducts()).join(', ')}. Or pass --repo owner/name.`);
  }
  const fromRemote = choice.remote ? repoFromRemote(choice.remote) : undefined;
  if (fromRemote) return fromRemote;
  throw new Error(
    `Which product? Name one (${Object.keys(activeProducts()).join(', ')}), pass --repo owner/name, or run inside the repo.`,
  );
}

// The product and environment named on the command line, in either order:
// `ship deploy ads production`, `ship production ads` and `ship ads production` all mean the same.
export function parseTarget(args: readonly string[]): { product?: string; environment?: string } {
  const product = args.find((arg) => arg in PRODUCTS);
  const environment = args.find((arg) => arg !== product);
  return { product, environment };
}

