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
ship status all                            # every product: what is live, and how far behind its default branch
ship status gaminginit-bot                 # one product: what is live in each environment, and how far behind main
ship diff gaminginit-bot                   # the commits waiting to ship
ship log gaminginit-bot -n 10              # recent deploys and their state
ship deploy gaminginit-bot production      # check, confirm, start the deploy and follow it
ship production gaminginit-bot             # same as deploy
ship rollback gaminginit-bot production    # put back the commit that was live before, and follow it
```

- It runs from any folder. Name a product from `src/products.ts`, pass `--repo owner/name`, or run
  it inside the repo's checkout and leave the product out.
- `ship status all` lists every product in `src/products.ts`, from any folder. A bare `ship status`
  does the same outside a product's checkout; inside one (or with `--repo`) it shows only that
  product. A product that can't be read shows as one ⚠️ line.
- The environment is optional when `ship.yaml` has only one.
- It signs in with `GH_TOKEN`, `GITHUB_TOKEN` or your `gh` login. `status`, `diff` and `log` also
  work without a token on public repos, within GitHub's rate limit.
- `deploy` runs the same gate as the workflow on the head of the default branch, shows the commits
  going out, asks before it starts (`--yes` skips that), starts the repo's deploy workflow and
  prints each job as it finishes. `--no-wait` starts it and exits. `--redeploy` deploys a commit
  that is already live.
- `rollback` puts back the commit that was live before the live one (`--to <sha>` picks another
  earlier live commit; 7 characters are enough). It shows the commits being taken out, asks first
  (`--yes` skips that), starts the repo's rollback workflow and follows it like `deploy`. See
  [Rolling back](#rolling-back).
- 🚨 **Production asks twice.** `deploy` and `rollback` to an environment named `production`
  print a red warning, ask the usual yes/no, then ask you to type the product name. `--yes`
  skips only the yes/no, never the typed name, so production can't be shipped by accident or
  from a script.
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
  rollbackWorkflow: ship-rollback.yml   # what ship rollback starts (optional, this is the default)
```

`dist/` holds the compiled CLI and is committed, so installing from GitHub needs no build. Run
`pnpm build` after changing `src/`; CI fails if `dist/` is out of date.

## What a deploy does

1. **Gate.** Blocks the deploy unless:
   - the commit is on the repo's default branch;
   - every check named in `checks` has passed on that commit;
   - the commit already has a successful deployment in every environment named in `requires`;
   - the commit is not older than what is live in the environment (a rollback instead needs a
     commit that was live there before; see [Rolling back](#rolling-back)). This is checked again
     inside the deploy job, which runs one at a time, so re-running an old CI run, or a run that
     waited behind a newer deploy, can't put older code back.
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

## Rolling back

`ship rollback` redeploys an older commit through the normal pipeline: the gate, build, D1
migrations, `wrangler deploy`, health check and Discord message all run as for any deploy. It is a
deploy of old code, not an undo: **D1 migrations are forward-only and are not undone**, so the old
code runs against the newer schema.

The gate treats a rollback differently in one way: the commit may be older than what is live, but
it must already have had a successful deployment to the same environment ("<sha> was never live on
production, so it can't be a rollback target"). Every other rule (default branch, checks,
`requires`) still applies.

Each product repo needs this workflow at `.github/workflows/ship-rollback.yml` (or another name set
in `dispatch.rollbackWorkflow`). `ship rollback` tells you to add it if it is missing:

```yaml
name: Ship rollback
on:
  workflow_dispatch:
    inputs:
      environment: { description: Environment to roll back, required: true, type: string }
      sha: { description: Commit to deploy, required: true, type: string }
jobs:
  rollback:
    permissions: { contents: read, checks: read, deployments: write }
    uses: ideaSquared/shipper/.github/workflows/deploy.yml@v1
    with:
      environment: ${{ inputs.environment }}
      sha: ${{ inputs.sha }}
      rollback: true
    secrets: inherit
```

The shipper workflow takes two inputs for this, usable from any caller: `sha` (the full SHA to
check out and deploy; empty means the run's own commit) and `rollback` (`true` to allow an older,
previously live commit).

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
   named exactly as in `ship.yaml` (`production`, `staging`). It holds the environment's secrets and
   any required reviewers. Create it before the first deploy: when gaminginit and ideasquared-bot first
   deployed, GitHub did not create it from the workflow's `inputs.environment`, and the deploy job
   failed at once with "environment not found" until it was created by hand. On a private repo,
   environments need a paid GitHub plan.
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

## A repo with its own deploy workflow

Some products already deploy with a workflow of their own (images, approvals, signing, a server
over SSH) that shipper shouldn't replace. For those, `ship.yaml` lists one `type: external`
component, and the repo calls shipper's gate before its deploy and the report after it:

```yaml
# ship.yaml
components:
  stack:
    type: external
    workflow: .github/workflows/deploy.yml
```

```yaml
jobs:
  gate:
    permissions: { contents: read, checks: read, deployments: read }
    uses: ideaSquared/shipper/.github/workflows/gate.yml@v1
    with: { environment: staging }
    secrets: inherit
  deploy:
    needs: gate
    uses: ./.github/workflows/deploy.yml     # the repo's own, with a workflow_call trigger
    with: { environment: staging }
    secrets: inherit
  report:
    needs: [gate, deploy]
    if: always() && needs.gate.result == 'success'
    uses: ideaSquared/shipper/.github/workflows/report.yml@v1
    with: { environment: staging, outcome: '${{ needs.deploy.result }}' }
    secrets: inherit
```

- The gate is the same as `deploy.yml`'s; a blocked commit fails the run and posts "blocked".
- The repo's deploy job runs in the GitHub Environment (without `deployment: false`), so GitHub
  records the Deployment for the run's commit, which is what `ship status`, the gate and the
  board read.
- The report posts the usual Discord message with the commit range since the last live commit.
- `ship deploy`, `ship status`, `ship diff` and `ship log` work as for any product;
  `ship rollback` needs the repo's own rollback workflow named in `dispatch.rollbackWorkflow`.

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
