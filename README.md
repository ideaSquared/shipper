# shipper

Deploy tooling for every ideaSquared product. Each product repo describes what it deploys in a
`ship.yaml`, and calls one shared GitHub Actions workflow to deploy it. The idea comes from Monzo's
Shipper: one way to deploy, with the safety rules built into the tool rather than written down.

This is step 1 of the plan: the manifest, the gate and the Cloudflare Workers deploy. The `ship`
command-line tool comes next.

## What a deploy does

1. **Gate.** Blocks the deploy unless:
   - the commit is on the repo's default branch;
   - every check named in `checks` has passed on that commit;
   - the commit already has a successful deployment in every environment named in `requires`.
2. **Deploy.** For each component, in the order written in `ship.yaml`: run `build`, apply D1
   migrations, then `wrangler deploy` with a message naming the commit and who shipped it. The first
   component that fails stops the rest.
3. **Health check.** If a component sets `health`, poll it for about a minute. If it never answers,
   run `wrangler rollback` to the previous version and fail the deploy. D1 migrations are
   forward-only and are not undone.

The deploy job runs in the GitHub Environment named after the target environment. GitHub records it
as a Deployment, which the ideaSquared bot posts to Discord, and the Environment holds the secrets
and any required reviewers.

## ship.yaml

```yaml
product: creatrgrid
checks: [verify, e2e]            # check runs that must pass on the commit (optional)
environments:
  staging:
    wranglerEnv: staging         # passed to wrangler --env (optional)
  production:
    requires: [staging]          # only commits already live on staging (optional)
components:                      # deployed in this order
  api:
    type: cloudflare-worker
    path: services/api           # folder with the wrangler config (default: .)
    migrations: { d1: creatorgrid-db }
    health: /api/v1/health       # path on the deployed URL, or a full URL (optional)
  web:
    type: cloudflare-worker
    path: apps/web
    build: pnpm --filter @creatorgrid/app.web build   # run from the repo root (optional)
```

Unknown keys are rejected, so a typo fails the deploy instead of being ignored. `cloudflare-worker`
is the only component type so far.

## Using it in a repo

1. Add `ship.yaml` at the repo root.
2. Put `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the GitHub Environment for each target
   (or in the repo secrets).
3. Call the workflow from a job:

```yaml
jobs:
  test:
    # ...
  deploy:
    needs: test
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    permissions:
      contents: read
      checks: read
      deployments: read
    uses: ideaSquared/shipper/.github/workflows/deploy.yml@v1
    with:
      environment: production
    secrets: inherit
```

The repo must use pnpm: the workflow runs `pnpm install --frozen-lockfile` and `pnpm exec wrangler`.

## Versions

Product repos use the `v1` tag, and the workflow checks out its own scripts at `v1` too
(`shipper-ref`). To release a compatible change, merge to `main` and move the tag:

```bash
git tag -f v1 origin/main
git push -f origin v1
```

A breaking change to `ship.yaml` or the workflow inputs gets a new `v2` tag.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
```

The scripts are TypeScript run directly by Node 22.18 or newer (type stripping), so there is no build
step. `src/main.ts` is what the workflow runs.
