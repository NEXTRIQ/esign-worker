# Contributing

Thanks for considering a contribution. Bug reports, fixes and small,
well-scoped features are welcome. For larger changes, open an issue first so
we can agree on the approach.

## Workflow

1. Fork and create a branch from `main`.
2. `npm install`, then make your change with tests.
3. Run `npm run check` (typecheck, lint, format check and tests). CI runs the
   same steps.
4. Open a pull request that explains what changed and why.

## Guidelines

- Keep the scope small: this project aims to stay readable in one sitting.
- Every state change must be safe under concurrency (conditional updates, not
  read-then-write) and must not weaken the evidence guarantees.
- Never log signing tokens or raw IP addresses.
- Comments explain why, not what.
- Fixtures use obviously fictional data (`Jane Doe`, `signer@example.com`).

Report security issues privately; see [SECURITY.md](SECURITY.md).
