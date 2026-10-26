# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Instead, open a
[private security advisory](../../security/advisories/new) on this repository
(Security tab, "Report a vulnerability").

Include what you found, how to reproduce it and what impact you expect. We aim
to acknowledge reports within five working days and will keep you informed
while we work on a fix. We are happy to credit you in the release notes.

## Scope

In scope: the code in this repository, including the signing flow, token
handling, evidence generation, the admin API and the default configuration.

Out of scope: vulnerabilities in Cloudflare's platform or third-party
dependencies (report those upstream), and issues that require a leaked
`ADMIN_TOKEN` or `APP_SECRET`.

## Supported versions

Only the latest commit on `main` receives fixes.
