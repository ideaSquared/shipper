# Changelog

All notable changes are listed here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/). The release PR adds the entry and bumps `version` in
`package.json`; the Release workflow then tags `vX.Y.Z`, publishes the GitHub Release and moves `v1`.

## [1.1.0] - Unreleased

### Added

- Queued deploys. When the only things blocking a deploy are `checks:` still running, or a `requires`
  environment the commit is being deployed to right now, the gate in `deploy.yml` and `gate.yml` waits for
  them instead of failing. It goes on as soon as they pass, and fails as soon as a check fails or when the
  time runs out. The new `wait-minutes` input sets the limit (default 30; `0` fails at once, as before).
  A Deployment left unfinished by a run that is over (cancelled, timed out, lost its runner) does not count
  as a deploy under way, so the gate fails at once instead of waiting for it.
- `ship deploy` no longer refuses while checks are only running: it starts the workflow, says the deploy is
  queued and what it waits for, and shows which checks are still running before following the jobs.
- Ctrl-C while `ship deploy` or `ship rollback` follows a run says the run keeps going, with its link.

## [1.0.0] - Unreleased

First tagged release of the `ship` command and the reusable workflows (`deploy.yml`, `gate.yml`,
`report.yml`) that the `v1` tag has pointed at so far.

### Added

- `ship --version`.
- `ship` and the workflows run on Node 24; the reusable workflows read the version from `.nvmrc`.
- Releases are tagged `vX.Y.Z` with a GitHub Release, and `CHANGELOG.md`.

### Security

- Every action in the workflows is pinned to a full commit SHA, kept current by Dependabot.
- `SECURITY.md` says how to report a vulnerability privately.
