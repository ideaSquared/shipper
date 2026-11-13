// Products deployed with shipper, so `ship <command> <product>` works from any folder.
// Add a line when a repo starts using ship.yaml.
export const PRODUCTS = {
    creatrgrid: 'ideaSquared/creatrgrid',
    gaminginit: 'ideaSquared/gaminginit',
    'gaminginit-bot': 'ideaSquared/gaminginit-bot',
    'ideasquared-bot': 'ideaSquared/ideasquared-bot',
};
// owner/name from a GitHub remote URL (https or ssh), or undefined for anything else.
export function repoFromRemote(remote) {
    const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
    return match ? `${match[1]}/${match[2]}` : undefined;
}
// --repo wins, then a product name, then the folder's git remote.
export function resolveRepo(choice) {
    if (choice.repo)
        return choice.repo;
    if (choice.product) {
        const repo = PRODUCTS[choice.product];
        if (repo)
            return repo;
        throw new Error(`Unknown product '${choice.product}'. Known: ${Object.keys(PRODUCTS).join(', ')}. Or pass --repo owner/name.`);
    }
    const fromRemote = choice.remote ? repoFromRemote(choice.remote) : undefined;
    if (fromRemote)
        return fromRemote;
    throw new Error(`Which product? Name one (${Object.keys(PRODUCTS).join(', ')}), pass --repo owner/name, or run inside the repo.`);
}
