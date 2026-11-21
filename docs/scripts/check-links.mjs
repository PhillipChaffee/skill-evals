/* global URL, console, process */

// Checks every link and asset of the built site: each address a page names
// inside the site must be a file of the build, and each #fragment must be an
// id of the page it points at. The site is served from a base path, so an
// address that leaves the base is an error too: it would work on a domain of
// its own and break on GitHub Pages.
//
// Usage: node scripts/check-links.mjs <folder that holds the built site>
import fs from "node:fs";
import path from "node:path";
import { SITE_URL } from "../site-url.mjs";

const root = path.resolve(process.argv[2] ?? "dist");
const site = new URL(SITE_URL);

/** @returns {string[]} Every HTML file under a folder. */
const pagesUnder = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return pagesUnder(file);
    return entry.name.endsWith(".html") ? [file] : [];
  });

/** @returns {string} The file that serves an address of the site. */
const fileOf = (pathname) => {
  const relative = decodeURIComponent(pathname.slice(site.pathname.length));
  return path.join(
    root,
    relative.endsWith("/") || relative === ""
      ? `${relative}index.html`
      : relative,
  );
};

const idsByFile = new Map();
/** @returns {Set<string>} The ids a page defines, read once for each page. */
const idsOf = (file) => {
  if (!idsByFile.has(file)) {
    const html = fs.readFileSync(file, "utf8");
    idsByFile.set(
      file,
      new Set([...html.matchAll(/\sid="([^"]*)"/g)].map((match) => match[1])),
    );
  }
  return idsByFile.get(file);
};

const problems = [];
let checked = 0;
for (const page of pagesUnder(root)) {
  // A canonical link names the page's own address, which the 404 page lacks.
  const html = fs
    .readFileSync(page, "utf8")
    .replace(/<link rel="canonical"[^>]*>/g, "");
  const relative = path.relative(root, page).split(path.sep).join("/");
  const address = new URL(relative.replace(/index\.html$/, ""), site);
  for (const [, link] of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
    const target = new URL(link.replaceAll("&amp;", "&"), address);
    if (target.origin !== site.origin || !/^https?:$/.test(target.protocol))
      continue;
    checked += 1;
    if (!target.pathname.startsWith(site.pathname)) {
      problems.push(
        `${relative}: ${link} leaves the base path ${site.pathname}`,
      );
      continue;
    }
    const file = fileOf(target.pathname);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      problems.push(`${relative}: ${link} has no file in the build`);
    } else if (
      target.hash.length > 1 &&
      file.endsWith(".html") &&
      !idsOf(file).has(decodeURIComponent(target.hash.slice(1)))
    ) {
      problems.push(`${relative}: ${link} names an id the page does not have`);
    }
  }
}

console.log(`${checked} internal links and assets checked in ${root}`);
if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`${problems.length} broken`);
  process.exitCode = 1;
}
