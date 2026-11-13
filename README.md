# shipper

Deploy tooling for every ideaSquared product. Each product repo describes what it deploys in a
`ship.yaml`, and calls one shared GitHub Actions workflow to deploy it. The idea comes from Monzo's
Shipper: one way to deploy, with the safety rules built into the tool rather than written down.

It has three parts: the manifest and the shared workflow (gate, Cloudflare Workers deploy, health
check and rollback, Discord message), and the `ship` command-line tool.

## The ship command

```bash
pnpm add -g github:ideaSquared/shipper     # install or update
```

```bash
ship status                                # every product: what is live, and how far behind its default branch
ship status gaminginit-bot                 # one product: what is live in each environment, and how far behind main
ship diff gaminginit-bot                   # the commits waiting to ship
ship log gaminginit-bot -n 10              # recent deploys and their state
ship deploy gaminginit-bot production      # check, confirm, start the deploy and follow it
ship production gaminginit-bot             # same as deploy
```

- It runs from any folder. Name a product from `src/products.ts`, pass `--repo owner/name`, or run
  it inside the repo's checkout and leave the product out.
- `ship status` with no product lists every product in `src/products.ts` (`ship status all` does
  too, even inside a product's checkout). A product that can't be read shows as one ⚠️ line.
- The environment is optional when `ship.yaml` has only one.
- It signs in with `GH_TOKEN`, `GITHUB_TOKEN` or your `gh` login. `status`, `diff` and `log` also
  work without a token on public repos, within GitHub's rate limit.
- `deploy` runs the same gate as the workflow on the head of the default branch, shows the commits
  going out, asks before it starts (`--yes` skips that), starts the repo's deploy workflow and
  prints each job as it finishes. `--no-wait` starts it and exits. `--redeploy` deploys a commit
  that is already live.
- Nothing builds on your machine: the deploy runs in GitHub Actions, so the Discord message names
  you as the person who shipped.
- Output uses colour and emojis. Colour turns off when the output is piped or `NO_COLOR` is set.
  Emojis need a modern terminal (Windows Terminal, VS Code, macOS, Linux); the old built-in
  Windows `cmd` window shows them as boxes.

For `ship deploy`, `ship.yaml` says which workflow to start. It must have a `workflow_dispatch`
trigger and call the shipper workflow:

```yaml
dispatch:
  workflow: ci.yml                 # file in .github/workflows
  environmentInput: environment    # the workflow input that takes the environment (optional)
```

`dist/` holds the compiled CLI and is committed, so installing from GitHub needs no build. Run
`pnpm build` after changing `src/`; CI fails if `dist/` is out of date.

## What a deploy does

1. **Gate.** Blocks the deploy unless:
   - the commit is on the repo's default branch;
   - every check named in `checks` has passed on that commit;
   - the commit already has a successful deployment in every environment named in `requires`;
   - the commit is not older than what is live in the environment. This is checked again inside
     the deploy job, which runs one at a time, so re-running an old CI run, or a run that waited
     behind a newer deploy, can't put older code back.
2. **Deploy.** For each component, in the order written in `ship.yaml`: run `build`, apply D1
   migrations, then `wrangler deploy` with a message naming the commit and who shipped it. The first
   component that fails stops the rest.
3. **Health check.** If a component sets `health`, poll it for about a minute. If it never answers,
   run `wrangler rollback` to the previous version and fail the deploy. D1 migrations are
   forward-only and are not undone.

The deploy job runs in the GitHub Environment named after the target environment, which holds the
secrets and any required reviewers. Shipper records the GitHub Deployment itself, for the commit it
deploys: it creates the Deployment once the in-job stale check passes (a blocked deploy is not a
deployment), marks it `in_progress`, then `success` (with the first deployed URL) or `failure`. The
job sets `deployment: false` so GitHub doesn't record a second one for the run's own commit.

## Discord message

After every deploy, and whenever the gate blocks one, shipper sends a signed report to the
ideaSquared bot (`POST /ship`). The bot posts it as an embed to the project's `-github` channel:
who shipped, when, the commit that was live before and the one now live, the commits in between,
and each component's result (deployed, rolled back with the reason, failed, or skipped).

It needs two things:

- `discord:` in `ship.yaml`, naming the bot project (`ads`, `pairflix`, `creatrgrid`, `gaminginit`,
  `ideasquared`);
- the `SHIP_NOTIFY_SECRET` org secret, which the bot holds too. The calling job passes it with
  `secrets: inherit`.

Without either, the deploy still runs and the job log says why no message was sent. A message
that fails to send never fails the deploy. Turn off "Deployment statuses" on the repo's bot webhook,
or the bot posts GitHub's plainer deployment message as well.

Each report also updates the live board in `#ship-status`: one message the bot edits, showing what is
live in every product and environment, who shipped it and when, and any failed or blocked attempt.

## ship.yaml

```yaml
product: creatrgrid
discord: creatrgrid              # bot project for the deploy message (optional)
dispatch: { workflow: deploy.yml, environmentInput: environment }   # for ship deploy (optional)
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

### Per-environment settings

A product with a staging environment usually needs a different Worker name, health URL and build
for each environment:

```yaml
environments:
  staging:
    wranglerEnv: staging         # wrangler deploy --env staging (an [env.staging] block in wrangler config)
  production:
    requires: [staging]          # production only takes commits already live on staging
components:
  api:
    type: cloudflare-worker
    path: services/api
    health:                      # one health check per environment
      staging: https://api-staging.example.com/api/v1/health
      production: /api/v1/health
  web:
    type: cloudflare-worker
    path: apps/web
    build: pnpm --filter @creatorgrid/app.web build:$SHIP_ENVIRONMENT
```

- `health` is either one path or URL for every environment, or a map from environment name to a
  path or URL. Every key must be an environment in `ship.yaml`. An environment the map leaves out
  has no health check: the component counts as deployed, with "no health check for staging".
- `build` runs with two extra environment variables: `SHIP_ENVIRONMENT` (the environment being
  deployed, e.g. `staging`) and `SHIP_WRANGLER_ENV` (its `wranglerEnv`, or empty when it has none).

## Using it in a repo

1. Add `ship.yaml` at the repo root.
2. Create a GitHub Environment for each target: repo → Settings → Environments → New environment,
   named exactly as in `ship.yaml` (`production`, `staging`). GitHub does not create it on first use,
   and the deploy job fails at once with "environment not found" without it. On a private repo, this
   needs a paid GitHub plan.
3. Put `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in that Environment or in the repo
   secrets. `SHIP_NOTIFY_SECRET` comes from the org.
4. Add the product to `src/products.ts` so `ship status` lists it and `ship <command> <product>`
   finds it, then run `pnpm build`.
5. Call the workflow from a job:

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
      deployments: write           # shipper creates the GitHub Deployment
    uses: ideaSquared/shipper/.github/workflows/deploy.yml@v1
    with:
      environment: production
    secrets: inherit
```

The job must grant `deployments: write`: without it the deploy job stops before deploying, with an
error saying so. The GitHub Environment from step 2 must still exist; `deployment: false` only stops
GitHub recording its own Deployment.

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

## Licence

[MIT](LICENSE)
