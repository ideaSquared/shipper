# Security policy

## Reporting a vulnerability

Please report it privately; do not open a public issue or pull request.

Use GitHub's private vulnerability reporting: <https://github.com/ideaSquared/shipper/security/advisories/new>.

Include what you found, how to reproduce it, and which commit or `v1` tag it affects.

## What to expect

- We acknowledge a report within 3 working days.
- We tell you whether we accept it as a vulnerability, and keep you updated until it is fixed.
- We fix accepted issues on `main` and, where the reusable workflows are affected, move the `v1` tag
  only through the approved release run. Credit is given in the advisory unless you prefer otherwise.

## Scope

shipper runs with deploy credentials in the repositories that call it, so anything that lets a change
reach a deploy without review, leaks a token, webhook URL or signing secret, or runs untrusted input in
the workflows is in scope.
