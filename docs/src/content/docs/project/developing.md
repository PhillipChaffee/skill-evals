---
title: Developing
description: The gates every change passes, and how the website and these docs are built.
---

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

The website has two parts. The `Pages` workflow builds them into one folder and deploys it to GitHub Pages.

- **The landing page** is static files in `site/`: `index.html`, `styles.css`, `copy.js`, and the icon. It has no build step and no dependencies. Open `site/index.html` in a browser to see a change. It links to the docs with relative addresses (`docs/`), which work once the built docs are beside it.
- **The docs** are a [Starlight](https://starlight.astro.build/) project in `docs/`. It has its own `package.json` and lockfile, so Astro is not in the dependency tree of the package you install from npm. The pages are Markdown files in `docs/src/content/docs/`, and they read as plain Markdown on GitHub too.

```sh
npm ci                # in the repository root: the reference pages are written from src/
cd docs && npm ci
npm run dev           # the docs alone, with live reload
npm run build         # writes docs/dist/: the landing page, the docs under docs/, then a link check
npm run preview       # serves docs/dist/ under the site's base path, as GitHub Pages does
```

Prettier and ESLint check both folders with the rest of the repository, the lockfile and advisory gates read `docs/package-lock.json` too, and the npm package holds neither folder.

The landing page repeats facts from the README and the docs: the check types, the command, the requirements, and the sample report. When one of them changes, change the page too.

### Generated pages

These pages are written from the code, so they cannot say something the tool does not do. Do not edit them. Change the source, then run `npm run docs:reference` in the repository root.

| Page                    | Written from                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `reference/checks.md`   | The check types, fields, and tool kinds in `src/checks.ts` and `src/harnesses/shared.ts`.                   |
| `reference/commands.md` | The commands in `src/cli.ts` and the flags in `src/usage.ts`. The help text comes from the same two tables. |
| `reference/config.md`   | The config keys in `src/project.ts`, each with the flag of the same name.                                   |
| `reference/api.md`      | The doc comments of everything `src/index.ts` exports.                                                      |
| `agents/harnesses.md`   | The harness registry in `src/harnesses/index.ts`.                                                           |
| `project/changelog.md`  | `CHANGELOG.md`. The docs build copies it, and the copy is not committed.                                    |

The first five are committed, because the other pages and the README link to them and those links have to work on GitHub. `src/docs/reference.test.ts` compares each one with what the code says, so `npm test` fails while a committed page is stale. `src/docs/examples.test.ts` runs every `json` example in the docs and the README through the tool's own validation, so an example the tool would reject fails too.

### Links and the site's address

Link from one page to another by its file, as in `[Checks](../reference/checks.md)`. That works on GitHub, and the build turns it into the page's address (`docs/repo-markdown.mjs`). The same file turns a GitHub alert such as `> [!WARNING]` into the site's own callout.

The site is served from a path of its own, `/skill-evals/` on GitHub Pages. `docs/site-url.mjs` is the one place that says so. For a custom domain, change that one line. `npm run build` ends with `docs/scripts/check-links.mjs`, which fails on a link or asset that has no file in the build, on a fragment that the target page lacks, and on an address that leaves the base path.

### Deployment

The `Pages` workflow builds and deploys on every push to `main` that changes `site/`, `docs/`, `src/`, or `CHANGELOG.md`, and when someone starts it by hand. On a pull request that changes them it builds the site and checks its links, and deploys nothing. One setting lives in the repository's settings and not in this repository: under Pages, the source must be "GitHub Actions". Until that is set, the deploy job fails.
