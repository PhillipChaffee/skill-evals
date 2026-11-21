---
title: Releasing
description: How a version tag becomes a release on npm.
---

Pushing a version tag publishes the package to npm. Nothing on `main` makes a tag or publishes.

1. Open a pull request that sets `version` in `package.json` (and `package-lock.json`) and adds a `## <version>` entry to `CHANGELOG.md`. The `Release check` workflow fails the pull request when the version could not ship.
2. Merge it.
3. Tag the merge commit and push the tag:

   ```sh
   git tag v<version> <commit> && git push origin v<version>
   ```

The `Publish` workflow then runs the guards in `scripts/release-plan.sh`, every gate above, `npm publish --provenance`, and makes the GitHub release from the changelog entry. It refuses a tag when:

- the tag is not `v` plus the version in `package.json` at that commit
- the tagged commit is not on `main`
- the version is not `MAJOR.MINOR.PATCH`, or has no changelog entry
- the version is not above the latest one on npm
- the registry cannot be reached

A tag whose version is already on npm publishes nothing, so running the workflow again is safe.

Two guards live in the repository's settings and not in this repository:

- **Who may push a tag.** A tag ruleset for `v*` limits who can create, move, or delete a version tag.
- **A person's approval.** The workflow runs in the `npm` environment. Required reviewers on that environment make every release wait for an approval.

The workflow reads the npm token from the `NPM_TOKEN` secret.
