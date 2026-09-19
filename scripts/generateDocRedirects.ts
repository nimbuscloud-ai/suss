#!/usr/bin/env node
/**
 * generateDocRedirects.ts: write one small HTML page per old docs URL, so a
 * bookmark from before the site was reorganised still lands on the page it
 * wants.
 *
 * GitHub Pages serves static files and nothing else, so a redirect has to be
 * a page that redirects itself: a meta refresh for the browser, a canonical
 * link for a crawler, and a plain link for the reader the refresh misses.
 *
 * `npm run docs:build` runs this through `predocs:build`. On its own:
 *
 *   node --experimental-strip-types scripts/generateDocRedirects.ts
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
// VitePress copies docs/public into the build output as it is.
const OUTPUT_DIR = path.join(ROOT, "docs", "public");

const BASE = process.env.SUSS_DOCS_BASE ?? "/";

const SITE_ORIGIN = "https://suss.sh/";

const REPOSITORY_BLOB = "https://github.com/nimbuscloud-ai/suss/blob/main";

/**
 * Old path (no leading or trailing slash) -> where it went. A value starting
 * with "https://" leaves the site, for a page no longer published.
 */
const MOVES: Record<string, string> = {
  "tutorial/get-started": "start/quickstart",
  "tutorial/pair-frontend-backend": "guides/check-against-openapi",
  "guides/mcp-server": "start/give-your-agent-suss",
  "guides/pair-against-openapi": "guides/check-against-openapi",
  "guides/suppress-findings": "guides/accept-a-finding",
  "guides/pack-health": "guides/fix-an-empty-run",
  "guides/writing-a-pack": "packs/write-a-pack",
  suppressions: "guides/accept-a-finding",
  "dependency-stubs": "guides/teach-a-dependency",
  packs: "packs/what-a-pack-is",
  "reference/packages": "packs/catalog",
  "reference/pack-patterns": "packs/patterns",
  "reference/cli": "reference/cli/",
  "contract-sources": "packs/contract-sources",
  "behavioral-summary-format": "reference/summary-format",
  "ir-reference": "reference/ir",
  glossary: "reference/glossary",
  faq: "reference/faq",
  "whats-new": "reference/changelog",
  motivation: "why/the-problem",
  contracts: "why/kinds-of-contract",
  "cross-boundary-checking": "why/cross-boundary-checking",
  architecture: "theory/architecture",
  "boundary-semantics": "theory/boundary-semantics",
  "extraction-algorithm": "theory/extraction-algorithm",
  "resolving-values": "theory/resolving-values",
  pipelines: "theory/pipelines",
  "internal/facts-and-rules": "theory/facts-and-rules",
  "internal/protocol-assumptions": "theory/protocol-assumptions",
  "internal/concept-design": "theory/prior-art",
  // These five left the site and live in the repository now.
  "internal/differential-fuzzing": `${REPOSITORY_BLOB}/design/docs-internal/differential-fuzzing.md`,
  "internal/dogfooding": `${REPOSITORY_BLOB}/design/docs-internal/dogfooding.md`,
  "internal/quality": `${REPOSITORY_BLOB}/design/docs-internal/quality.md`,
  "internal/releasing": `${REPOSITORY_BLOB}/design/docs-internal/releasing.md`,
  "internal/style": `${REPOSITORY_BLOB}/design/docs-internal/style.md`,
};

function destinationUrl(target: string): string {
  return target.startsWith("https://") ? target : `${BASE}${target}`;
}

function canonicalUrl(target: string): string {
  return target.startsWith("https://") ? target : `${SITE_ORIGIN}${target}`;
}

function page(target: string): string {
  const href = destinationUrl(target);
  const canonical = canonicalUrl(target);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="robots" content="noindex" />
    <meta http-equiv="refresh" content="0; url=${href}" />
    <link rel="canonical" href="${canonical}" />
    <title>This page moved</title>
  </head>
  <body>
    <p>This page moved. <a href="${href}">Go to its new home</a>.</p>
  </body>
</html>
`;
}

let written = 0;
for (const [from, to] of Object.entries(MOVES)) {
  const file = path.join(OUTPUT_DIR, `${from}.html`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, page(to), "utf8");
  written += 1;
}

process.stdout.write(
  `redirects: ${written} pages -> ${path.relative(ROOT, OUTPUT_DIR)}\n`,
);
