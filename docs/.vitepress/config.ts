import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitepress";

import { glossary } from "./glossary.js";
import { glossaryLinkPlugin } from "./plugins/glossary-link.js";
import { pageTitleLinkPlugin } from "./plugins/page-title-link.js";
import { sourceFileLinkPlugin } from "./plugins/source-file-link.js";
import { sidebar } from "./sidebar.js";

const docsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// The sitemap, the canonical link and the Open Graph tags each need an
// absolute URL, which none of them can work out from `base` alone.
const SITE_ORIGIN = "https://suss.sh/";

const OG_IMAGE = `${SITE_ORIGIN}og.png`;

const REPOSITORY = "https://github.com/nimbuscloud-ai/suss";

// The site is served from the root of suss.sh. SUSS_DOCS_BASE is for a
// build that has to live under a prefix, such as a preview of the site
// at a project-pages URL.
const BASE = process.env.SUSS_DOCS_BASE ?? "/";

// The license is a fact about the package, so read it rather than restate it.
const { license } = JSON.parse(
  fs.readFileSync(path.join(docsRoot, "..", "package.json"), "utf8"),
) as { license: string };

function firstWithText(...candidates: (string | undefined)[]): string {
  return candidates.find((candidate) => (candidate ?? "").trim() !== "") ?? "";
}

/** The public URL of a page, given the markdown file VitePress read it from. */
function pageUrl(relativePath: string): string {
  const withoutExtension = relativePath.replace(/\.md$/, "");
  const withoutIndex = withoutExtension.replace(/(^|\/)index$/, "$1");
  return `${SITE_ORIGIN}${withoutIndex}`;
}

const SITE_DESCRIPTION =
  "Reads your code and checks what it does at every boundary, a route, a table or a queue, against the clients, specs and infrastructure on the other side. TypeScript, Python and Ruby.";

/** Question-and-answer pairs from the FAQ page's H2 headings. */
function faqQuestions() {
  const source = fs.readFileSync(
    path.join(docsRoot, "reference", "faq.md"),
    "utf8",
  );
  const questions = [];

  for (const section of source.split(/^## /m).slice(1)) {
    const [heading, ...body] = section.split("\n");
    const answer = body
      .join("\n")
      .split("\n\n")
      .map((block) => block.trim())
      .find((block) => block !== "" && !/^[`|>*-]/.test(block));

    if (!heading.trim().endsWith("?") || answer === undefined) {
      continue;
    }

    questions.push({
      "@type": "Question",
      name: heading.trim(),
      acceptedAnswer: { "@type": "Answer", text: answer },
    });
  }

  return questions;
}

/** The JSON-LD for a page, for the two pages that have any. */
function structuredData(relativePath: string): object | null {
  if (relativePath === "index.md") {
    return {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "suss",
      description: SITE_DESCRIPTION,
      applicationCategory: "DeveloperApplication",
      license: `https://spdx.org/licenses/${license}.html`,
      codeRepository: REPOSITORY,
    };
  }

  if (relativePath === "reference/faq.md") {
    return {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faqQuestions(),
    };
  }

  return null;
}

// The site reads straight from docs/*.md, so every markdown file is
// already a routeable page. sidebar.ts is the editorial ordering on top
// of that.

export default defineConfig({
  title: "suss",
  description: SITE_DESCRIPTION,
  lang: "en-US",
  sitemap: { hostname: SITE_ORIGIN },
  base: BASE,
  cleanUrls: true,
  lastUpdated: true,

  head: [
    [
      "link",
      { rel: "icon", type: "image/svg+xml", href: `${BASE}favicon.svg` },
    ],
    ["link", { rel: "icon", href: `${BASE}favicon.ico` }],
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

    const data = structuredData(pageData.relativePath);

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
      ...(data === null
        ? []
        : [
            [
              "script",
              { type: "application/ld+json" },
              JSON.stringify(data),
            ] as [string, Record<string, string>, string],
          ]),
    ];
  },

  themeConfig: {
    // VitePress runs logo through withBase itself, so this stays
    // base-relative rather than interpolating BASE.
    logo: "/mark.svg",

    // Top-level nav stays small on purpose, most of the site
    // lives in the sidebar.
    nav: [
      { text: "Get started", link: "/start/quickstart" },
      { text: "Guides", link: "/guides/add-to-project" },
      { text: "Reference", link: "/reference/cli/" },
      { text: "Packs", link: "/packs/catalog" },
      { text: "Why suss", link: "/why/the-problem" },
      {
        text: "GitHub",
        link: "https://github.com/nimbuscloud-ai/suss",
      },
    ],

    sidebar,

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

  // The pack tables link a pack to its package directory and its coverage
  // badge, both outside the site. Everything else is checked.
  ignoreDeadLinks: [/\.\.\/\.\.\/packages\//, /\.\.\/\.\.\/\.github\//],
});
