import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitepress";

import { glossary } from "./glossary.js";
import { glossaryLinkPlugin } from "./plugins/glossary-link.js";
import { pageTitleLinkPlugin } from "./plugins/page-title-link.js";
import { sourceFileLinkPlugin } from "./plugins/source-file-link.js";

const docsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// VitePress config — the site reads straight from docs/*.md, so
// every existing markdown file is already a routeable page. The
// sidebar below is the editorial grouping — it orders what's
// "start here" vs "reference" vs "internals" rather than dumping
// every file in a flat list.

export default defineConfig({
  title: "suss",
  description:
    "Static behavioral analysis for TypeScript. Extract, compare, and publish summaries of what your code does.",
  // GitHub Pages serves from /<repo>/, so assets + links resolve
  // relative to that prefix. Easiest toggle for local dev is
  // SUSS_DOCS_BASE — unset for root serving, set to "/suss/" for
  // project-pages deploy.
  base: process.env.SUSS_DOCS_BASE ?? "/suss/",
  cleanUrls: true,
  lastUpdated: true,

  head: [
    ["link", { rel: "icon", href: "/favicon.ico" }],
    [
      "meta",
      {
        name: "theme-color",
        content: "#3c82f6",
      },
    ],
  ],

  themeConfig: {
    // Top-level nav stays small on purpose — most of the site
    // lives in the sidebar.
    nav: [
      { text: "Tutorial", link: "/tutorial/get-started" },
      { text: "Guides", link: "/guides/add-to-project" },
      { text: "Reference", link: "/reference/cli" },
      { text: "Explanation", link: "/motivation" },
      {
        text: "GitHub",
        link: "https://github.com/nimbuscloud-ai/suss",
      },
    ],

    // Sidebar organized along Diátaxis lines:
    //   Tutorial   — learn by doing (one concrete walkthrough)
    //   How-to     — task recipes for users who know what they need
    //   Reference  — dry, complete factual information (CLI, findings, IR)
    //   Explanation — why the tool is shaped this way
    //   Internal   — ADR log, style guide, roadmaps (de-emphasized at the bottom)
    //
    // See diataxis.fr for the framework; mixing modes on one page is
    // the most common docs anti-pattern and this structure keeps them
    // separate.
    sidebar: [
      {
        text: "Tutorial",
        collapsed: false,
        items: [{ text: "Get started", link: "/tutorial/get-started" }],
      },
      {
        text: "How-to guides",
        collapsed: false,
        items: [
          { text: "Add suss to a project", link: "/guides/add-to-project" },
          { text: "Set up CI checking", link: "/guides/ci-integration" },
          {
            text: "Pair against OpenAPI",
            link: "/guides/pair-against-openapi",
          },
          { text: "Suppress a finding", link: "/guides/suppress-findings" },
          { text: "Write a framework pack", link: "/framework-packs" },
        ],
      },
      {
        text: "Reference",
        collapsed: false,
        items: [
          { text: "CLI commands & flags", link: "/reference/cli" },
          { text: "Findings catalog", link: "/reference/findings" },
          { text: "Summary format", link: "/behavioral-summary-format" },
          { text: "IR types & schemas", link: "/ir-reference" },
        ],
      },
      {
        text: "Explanation",
        collapsed: false,
        items: [
          { text: "Motivation", link: "/motivation" },
          {
            text: "Why behavioral summaries",
            link: "/why-behavioral-summaries",
          },
          { text: "Architecture", link: "/architecture" },
          { text: "Three kinds of truth", link: "/contracts" },
          { text: "Boundary semantics", link: "/boundary-semantics" },
          { text: "Pipelines", link: "/pipelines" },
          { text: "Extraction algorithm", link: "/extraction-algorithm" },
          { text: "Cross-boundary checking", link: "/cross-boundary-checking" },
          { text: "Stubs", link: "/stubs" },
          { text: "Suppressions (model)", link: "/suppressions" },
        ],
      },
      {
        text: "Internal",
        collapsed: true,
        items: [
          { text: "Status & decisions", link: "/internal/status" },
          { text: "Style guide", link: "/internal/style" },
          { text: "Concept design", link: "/internal/concept-design" },
          { text: "Quality", link: "/internal/quality" },
          { text: "Forward-looking backlog", link: "/internal/backlog" },
          { text: "React roadmap", link: "/internal/roadmap-react" },
          { text: "Dogfooding", link: "/internal/dogfooding" },
        ],
      },
    ],

    search: {
      provider: "local",
    },

    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/nimbuscloud-ai/suss",
      },
    ],

    editLink: {
      pattern: "https://github.com/nimbuscloud-ai/suss/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    footer: {
      message: "Released under the Apache-2.0 License.",
      copyright: "Copyright © 2025 Nimbus Cloud AI LLC",
    },
  },

  // Mermaid / extra markdown flavour can land later; for v0 the
  // default pipeline handles the existing docs (no custom
  // containers, no mermaid embeds).
  //
  // The three custom plugins below add cross-doc wiring the source
  // markdown shouldn't have to maintain by hand:
  //   1. glossaryLinkPlugin — auto-link inline-code IR types
  //      (`BoundaryBinding`, `Transition`, …) to their reference section.
  //   2. sourceFileLinkPlugin — auto-link inline-code repo paths
  //      (`packages/ir/src/schemas.ts`, `scripts/dogfood.mjs`) to
  //      the corresponding GitHub blob/tree URL.
  //   3. pageTitleLinkPlugin — rewrite placeholder-style internal
  //      markdown link text (`[some-page.md](some-page.md)`) to use
  //      the target page's h1 / frontmatter title.
  markdown: {
    lineNumbers: false,
    config: (md) => {
      md.use(glossaryLinkPlugin, { glossary });
      md.use(sourceFileLinkPlugin, {
        githubBlobBase: "https://github.com/nimbuscloud-ai/suss/blob/main",
        githubTreeBase: "https://github.com/nimbuscloud-ai/suss/tree/main",
        prefixes: ["packages/", "scripts/", "fixtures/"],
      });
      md.use(pageTitleLinkPlugin, { docsRoot });
    },
  },

  // The existing docs cross-link to source files via relative
  // paths like `../packages/framework/ts-rest/` — those render
  // fine on GitHub but produce 404s on the site. Skip the link
  // check for paths that escape the docs root; anything inside
  // the docs tree still gets validated.
  ignoreDeadLinks: [/packages\//, /fixtures\//, /\/\.\.\//, /^\.\.?\//],
});
