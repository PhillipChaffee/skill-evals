// @ts-check
/* global URL */
import fs from "node:fs";
import { satteri } from "@astrojs/markdown-satteri";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { repoMarkdown } from "./repo-markdown.mjs";
import { SITE_URL } from "./site-url.mjs";

const REPO = "https://github.com/PhillipChaffee/skill-evals";
const site = new URL(SITE_URL);
const FONTS =
  "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Inter:wght@400;500;600&display=swap";

/**
 * Copies the repository's changelog into the docs as a page, so the site
 * shows it and the repository keeps one copy.
 * @returns {import("astro").AstroIntegration}
 */
const changelogPage = () => ({
  name: "changelog-page",
  hooks: {
    "astro:config:setup": () => {
      const changelog = fs.readFileSync(
        new URL("../CHANGELOG.md", import.meta.url),
        "utf8",
      );
      fs.writeFileSync(
        new URL("src/content/docs/project/changelog.md", import.meta.url),
        `---\ntitle: Changelog\ndescription: What changed in each release of skill-evals.\neditUrl: false\n---\n\n${changelog.replace(/^# .*\n/, "")}`,
      );
    },
  },
});

export default defineConfig({
  site: site.origin,
  base: `${site.pathname}docs`,
  // The docs are built into a folder of their own so that the build script
  // can put the landing page beside them: dist/ is then the whole site.
  outDir: "dist/docs",
  trailingSlash: "always",
  markdown: { processor: satteri({ mdastPlugins: [repoMarkdown] }) },
  integrations: [
    changelogPage(),
    starlight({
      title: "skill-evals",
      description:
        "Run your skills across the scenarios you care about, in a real coding agent, and score each run against what you defined as success.",
      favicon: "/favicon.svg",
      customCss: ["./src/styles/theme.css"],
      head: [
        {
          tag: "link",
          attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" },
        },
        {
          tag: "link",
          attrs: {
            rel: "preconnect",
            href: "https://fonts.gstatic.com",
            crossorigin: true,
          },
        },
        { tag: "link", attrs: { rel: "stylesheet", href: FONTS } },
        { tag: "meta", attrs: { name: "theme-color", content: "#0d0f0c" } },
      ],
      social: [{ icon: "github", label: "GitHub", href: REPO }],
      editLink: { baseUrl: `${REPO}/edit/main/docs/` },
      components: {
        // The landing page's wordmark, which links back to the landing page.
        SiteTitle: "./src/components/SiteTitle.astro",
        // The site is dark only, like the landing page: nothing reads the
        // visitor's color scheme, and the header has no theme switch.
        ThemeProvider: "./src/components/Empty.astro",
        ThemeSelect: "./src/components/Empty.astro",
      },
      expressiveCode: { themes: ["vitesse-dark"] },
      sidebar: [
        {
          label: "Getting started",
          items: ["index", "quick-start", "safety"],
        },
        {
          label: "Guides",
          items: [
            "guides/write-a-case",
            "guides/organise-a-suite",
            "guides/judged-checks",
            "guides/decision-checks",
            "guides/read-the-report",
            "guides/pass-bars",
            "guides/jobs-resume-plan",
            "guides/ci",
            "guides/from-code",
          ],
        },
        {
          label: "Concepts",
          items: [
            "concepts/subjects",
            "concepts/one-run",
            "concepts/capabilities",
            "concepts/transcript",
          ],
        },
        {
          label: "Reference",
          items: [
            "reference/commands",
            "reference/exit-codes",
            "reference/checks",
            "reference/config",
            "reference/api",
          ],
        },
        {
          label: "Agents",
          items: [
            "agents/harnesses",
            "agents/how-they-run",
            "agents/verified",
            "agents/add-a-harness",
          ],
        },
        {
          label: "Project",
          items: [
            "project/developing",
            "project/releasing",
            "project/changelog",
          ],
        },
      ],
    }),
  ],
});
