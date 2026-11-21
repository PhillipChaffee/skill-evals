# Develop and release

## Develop

The sources are TypeScript in `src/`, with each test beside the code it covers. The lint, type, documentation, format, coverage, and hygiene gates come from the `typescript/` folder of [full-lint](https://github.com/PhillipChaffee/full-lint), whose README gives the reason for every rule.

```sh
npm ci
npm run format:check   # prettier
npm run typecheck      # tsc, strict and eight more flags
npm run lint           # eslint: typed rules, doc comments, size and complexity limits
npm test               # vitest; fails under 95% coverage of lines, functions, branches, or statements
npm run knip           # unused files, exports, and dependencies
npm run lint:lockfile  # every package comes from the npm registry over HTTPS
npm run lint:graph     # no import cycles, no orphan modules
npm run build          # compiles src/ to dist/, which is what the package ships
./run-gates.sh         # all of the above but the build, and the hygiene tools that CI installs
```

The tests run this package's code in the test process and start a stand-in harness from `test/fixtures/` as a real child process. One test packs the package, installs the tarball into an empty project, and runs it there.

`npm pack` and `npm publish` build first, so the tarball always holds a fresh `dist/`.

## Website

The landing page is static files in `site/`: `index.html`, `styles.css`, `copy.js`, and the icon. It has no build step and no dependencies. Open `site/index.html` in a browser to see a change. Prettier and ESLint check the folder with the rest of the repository, and the npm package does not hold it.

The page repeats facts from the README and these documents: the check types, the command, the requirements, and the sample report. When one of them changes, change the page too.

The `Pages` workflow deploys the folder to GitHub Pages on every push to `main` that changes `site/`, and when someone starts it by hand. One setting lives in the repository's settings and not in this repository: under Pages, the source must be "GitHub Actions". Until that is set, the deploy job fails.

## Release

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
