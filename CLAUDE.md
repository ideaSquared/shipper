# CLAUDE.md

shipper is the deploy tooling for every ideaSquared product: the `ship` CLI and a reusable GitHub Actions workflow driven by each repo's `ship.yaml` (see README.md).

## Working rules

- TypeScript strict, no `any`. Run `pnpm typecheck` and `pnpm test` before you call a change done.
- Run `pnpm build` and commit `dist/`: it is what `pnpm add -g github:ideaSquared/shipper` installs, and CI fails if it differs from `src/`.
- Conventional commits (`feat:`, `fix:`, `chore:` ...), one change per PR, tests with behaviour changes.

## Logging

- shipper's output is CLI output and GitHub Actions output for people, so it uses the terminal (`console`, workflow annotations), not `@ideasquared/log`.
- It must still never print secrets (tokens, webhook URLs, signing secrets) or personal data beyond the GitHub login of whoever ran the deploy.
- Any code that ever runs as a server must log through `@ideasquared/log`.
- Load the `logging` skill before adding log or output lines.
