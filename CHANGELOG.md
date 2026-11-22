# Changelog

All notable changes are listed here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/). The release PR adds the entry and bumps `version` in
`package.json`; the Release workflow then tags `vX.Y.Z`, publishes the GitHub Release and moves `v1`.

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
