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

// The sitemap, the canonical link and the Open Graph tags each need an
// absolute URL, which none of them can work out from `base` alone.
const SITE_ORIGIN = "https://nimbuscloud-ai.github.io/suss/";

const OG_IMAGE = `${SITE_ORIGIN}og.png`;

function firstWithText(...candidates: (string | undefined)[]): string {
  return candidates.find((candidate) => (candidate ?? "").trim() !== "") ?? "";
}

/** The public URL of a page, given the markdown file VitePress read it from. */
function pageUrl(relativePath: string): string {
  const withoutExtension = relativePath.replace(/\.md$/, "");
  const clean = withoutExtension.replace(/(^|\/)index$/, "$1");
  return `${SITE_ORIGIN}${clean}`;
}

// VitePress config: the site reads straight from docs/*.md, so
// every existing markdown file is already a routeable page. The
// sidebar below is the editorial grouping. It orders what's
// "start here" vs "reference" vs "internals" rather than dumping
// every file in a flat list.

export default defineConfig({
  title: "suss",
  description:
    "Reads your code and checks what each endpoint does against the clients, specs and infrastructure that depend on it. TypeScript, Python and Ruby.",
  lang: "en-US",
  sitemap: { hostname: SITE_ORIGIN },
  // GitHub Pages serves from /<repo>/, so assets + links resolve
  // relative to that prefix. Easiest toggle for local dev is
  // SUSS_DOCS_BASE: unset for root serving, set to "/suss/" for
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

  transformHead({ pageData, siteData }) {
    const url = pageUrl(pageData.relativePath);
    // The home page has an empty `title`, so the fallback tests for
    // content rather than for the key being there.
    const title = firstWithText(
      pageData.frontmatter.title,
      pageData.title,
      siteData.title,
    );
    const description = firstWithText(
      pageData.frontmatter.description,
      pageData.description,
      siteData.description,
    );

    return [
      ["link", { rel: "canonical", href: url }],
      ["meta", { property: "og:type", content: "website" }],
      ["meta", { property: "og:site_name", content: siteData.title }],
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: description }],
      ["meta", { property: "og:url", content: url }],
      ["meta", { property: "og:image", content: OG_IMAGE }],
      ["meta", { name: "twitter:card", content: "summary_large_image" }],
      ["meta", { name: "twitter:title", content: title }],
      ["meta", { name: "twitter:description", content: description }],
      ["meta", { name: "twitter:image", content: OG_IMAGE }],
    ];
  },

  themeConfig: {
    // Top-level nav stays small on purpose, most of the site
    // lives in the sidebar.
    nav: [
      { text: "Tutorial", link: "/tutorial/get-started" },
      { text: "Guides", link: "/guides/adopting-suss" },
      { text: "Reference", link: "/reference/cli" },
      { text: "Explanation", link: "/motivation" },
      {
        text: "GitHub",
        link: "https://github.com/nimbuscloud-ai/suss",
      },
    ],

    // Sidebar organized along Diátaxis lines:
    //   Tutorial: learn by doing (one concrete walkthrough)
    //   How-to: task recipes for users who know what they need
    //   Reference: dry, complete factual information (CLI, findings, IR)
    //   Explanation: why the tool is shaped this way
    //   Internals: how the pieces are built, for contributors
    //     (de-emphasized at the bottom)
    //
    // See diataxis.fr for the framework; mixing modes on one page is
    // the most common docs anti-pattern and this structure keeps them
    // separate.
    sidebar: [
      {
        text: "Tutorial",
        collapsed: false,
        items: [
          { text: "Get started", link: "/tutorial/get-started" },
          {
            text: "Pair a frontend with a backend",
            link: "/tutorial/pair-frontend-backend",
          },
        ],
      },
      {
        text: "How-to guides",
        collapsed: false,
        items: [
          { text: "Adopt suss one step at a time", link: "/guides/adopting-suss" },
          { text: "Add suss to a project", link: "/guides/add-to-project" },
          { text: "Set up CI checking", link: "/guides/ci-integration" },
          {
            text: "Pair against OpenAPI",
            link: "/guides/pair-against-openapi",
          },
          {
            text: "Read a Python or Ruby project",
            link: "/guides/python-and-ruby",
          },
          { text: "Suppress a finding", link: "/guides/suppress-findings" },
          { text: "Write a pack", link: "/guides/writing-a-pack" },
          { text: "Why a pack found nothing", link: "/guides/pack-health" },
        ],
      },
      {
        text: "Reference",
        collapsed: false,
        items: [
          { text: "CLI commands & flags", link: "/reference/cli" },
          { text: "Findings catalog", link: "/reference/findings" },
          { text: "Packages & packs", link: "/reference/packages" },
          { text: "Summary format", link: "/behavioral-summary-format" },
          { text: "IR types & schemas", link: "/ir-reference" },
          { text: "Pack patterns", link: "/reference/pack-patterns" },
          { text: "Compatibility", link: "/reference/compatibility" },
          { text: "FAQ", link: "/faq" },
        ],
      },
      {
        text: "Understanding suss",
        collapsed: false,
        items: [
          { text: "What's new", link: "/whats-new" },
          { text: "Motivation", link: "/motivation" },
          { text: "Glossary", link: "/glossary" },
          { text: "Contracts", link: "/contracts" },
          { text: "Cross-boundary checking", link: "/cross-boundary-checking" },
          { text: "Suppressions (model)", link: "/suppressions" },
          { text: "Dependency stubs", link: "/dependency-stubs" },
        ],
      },
      {
        // Contributor / maintainer material, how the pieces are built,
        // not what a user needs to run suss. Design records live in
        // design/ at the repository root instead, because everything
        // under docs/ is a published page whether the sidebar lists it
        // or not.
        text: "Internals",
        collapsed: true,
        items: [
          { text: "Architecture", link: "/architecture" },
          { text: "Packs", link: "/packs" },
          { text: "Boundary semantics", link: "/boundary-semantics" },
          { text: "Pipelines", link: "/pipelines" },
          { text: "Extraction algorithm", link: "/extraction-algorithm" },
          { text: "How suss follows a value", link: "/resolving-values" },
          { text: "Facts and rules", link: "/internal/facts-and-rules" },
          {
            text: "Protocol assumptions",
            link: "/internal/protocol-assumptions",
          },
          {
            text: "Differential fuzzing",
            link: "/internal/differential-fuzzing",
          },
          { text: "Contract sources", link: "/contract-sources" },
          { text: "Concept design", link: "/internal/concept-design" },
          { text: "Quality", link: "/internal/quality" },
          { text: "Style guide", link: "/internal/style" },
          { text: "Dogfooding", link: "/internal/dogfooding" },
          { text: "Releasing", link: "/internal/releasing" },
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
  //   1. glossaryLinkPlugin: auto-link inline-code IR types
  //      (`BoundaryBinding`, `Transition`, …) to their reference section.
  //   2. sourceFileLinkPlugin: auto-link inline-code repo paths
  //      (`packages/behavioral-ir/src/schemas.ts`, `scripts/dogfood.mjs`) to
  //      the corresponding GitHub blob/tree URL.
  //   3. pageTitleLinkPlugin: rewrite placeholder-style internal
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
  // paths like `../packages/framework/ts-rest/`: those render
  // fine on GitHub but produce 404s on the site. Skip the link
  // check for paths that escape the docs root; anything inside
  // the docs tree still gets validated.
  ignoreDeadLinks: [/packages\//, /fixtures\//, /\/\.\.\//, /^\.\.?\//],
});
