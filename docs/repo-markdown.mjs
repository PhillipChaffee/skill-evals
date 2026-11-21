// A remark plugin that lets the docs sources read well on GitHub and on the
// site. In the repository a page links to another page by its file, as in
// [Checks](../reference/checks.md), and warns with GitHub's alert syntax.
// The site needs the page's address and Starlight's own aside instead.

// GitHub's alert kinds, each with the Starlight aside that stands for it.
const ASIDES = {
  NOTE: "note",
  TIP: "tip",
  IMPORTANT: "note",
  WARNING: "caution",
  CAUTION: "danger",
};
const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/;
const PAGE_LINK = /^(?!\/|#|[a-z][a-z+.-]*:)([^#]*?)(index)?\.md(#.*)?$/i;

/**
 * Turns a link to a page's file into a link to the page's address.
 * @param {string} url - The address as written in the Markdown source.
 * @param {boolean} fromIndex - Whether the source is an index.md, whose
 *   address is its folder. Any other page's address is one level deeper than
 *   its file, so its relative links climb one level more.
 * @returns {string} The address on the site, still relative, so it works
 *   under any base path.
 */
const pageAddress = (url, fromIndex) =>
  url.replace(
    PAGE_LINK,
    (_, folders, index, hash = "") =>
      `${fromIndex ? "" : "../"}${folders}${index ? "" : "/"}${hash}`,
  );

/**
 * Turns a GitHub alert, a block quote that starts with [!WARNING], into the
 * container directive that Starlight renders as an aside.
 * @param {any} node - A block quote of the Markdown tree.
 * @returns {any} The directive, or nothing for any other block quote.
 */
function alertToAside(node) {
  const [paragraph, ...rest] = node.children;
  const [first, ...more] = paragraph?.children ?? [];
  const kind = first?.type === "text" && ALERT.exec(first.value)?.[1];
  if (!kind) return undefined;
  const text = { ...first, value: first.value.replace(ALERT, "") };
  return {
    type: "containerDirective",
    name: ASIDES[kind],
    children: [{ ...paragraph, children: [text, ...more] }, ...rest],
  };
}

/**
 * The plugin, in the shape Astro's Markdown processor takes.
 * @param {{ fileURL: URL }} page - The Markdown file being rendered.
 * @returns {object} What to do with each link and block quote of the page.
 */
export function repoMarkdown({ fileURL }) {
  const fromIndex = /\/index\.md$/.test(fileURL.pathname);
  const relink = (node) => ({ ...node, url: pageAddress(node.url, fromIndex) });
  return {
    name: "repo-markdown",
    link: relink,
    definition: relink,
    blockquote: alertToAside,
  };
}
