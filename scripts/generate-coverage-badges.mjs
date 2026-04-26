// generate-coverage-badges.mjs
// Reads coverage-summary.json files from each package and writes SVG badges
// to .github/badges/. Idempotent — no timestamps in output.
//
// Also normalizes coverage-summary.json: relativizes paths and pretty-prints.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeSummaryFile } from "./normalize-coverage-summary.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const badgesDir = resolve(root, ".github/badges");

mkdirSync(badgesDir, { recursive: true });

// Package dirs to check. Badge file slug is the second field;
// tracked at .github/badges/coverage-<slug>.svg. Keep in sync as
// new packs ship — there's no auto-discovery so a missing entry
// silently drops the package from the coverage average.
const packageDirs = [
  ["packages/ir", "ir"],
  ["packages/extractor", "extractor"],
  ["packages/adapter/typescript", "typescript"],
  ["packages/checker", "checker"],
  ["packages/cli", "cli"],
  // Frameworks
  ["packages/framework/ts-rest", "ts-rest"],
  ["packages/framework/react-router", "react-router"],
  ["packages/framework/react", "react"],
  ["packages/framework/express", "express"],
  ["packages/framework/fastify", "fastify"],
  ["packages/framework/apollo", "apollo"],
  ["packages/framework/nestjs-rest", "nestjs-rest"],
  ["packages/framework/nestjs-graphql", "nestjs-graphql"],
  ["packages/framework/prisma", "prisma"],
  ["packages/framework/aws-sqs", "aws-sqs"],
  ["packages/framework/process-env", "process-env"],
  // Runtimes
  ["packages/client/web", "web"],
  ["packages/client/axios", "axios"],
  ["packages/client/apollo", "apollo-client"],
  // Contract sources (renamed from stub-*; old badge files left
  // behind by the rename should be removed by hand when this
  // generator first writes the new ones).
  ["packages/contract/openapi", "contract-openapi"],
  ["packages/contract/aws-apigateway", "contract-aws-apigateway"],
  ["packages/contract/cloudformation", "contract-cloudformation"],
  ["packages/contract/appsync", "contract-appsync"],
  ["packages/contract/storybook", "contract-storybook"],
  ["packages/contract/prisma", "contract-prisma"],
];

function badgeColor(pct) {
  if (pct >= 80) {
    return "#4c1";
  }
  if (pct >= 60) {
    return "#dfb317";
  }
  return "#e05d44";
}

function makeSvg(label, value, color) {
  const labelWidth = label.length * 6 + 10;
  const valueWidth = value.length * 6 + 10;
  const totalWidth = labelWidth + valueWidth;
  const labelX = labelWidth / 2;
  const valueX = labelWidth + valueWidth / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <rect rx="3" width="${totalWidth}" height="20" fill="#555"/>
  <rect rx="3" x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>
  <rect x="${labelWidth}" width="4" height="20" fill="${color}"/>
  <rect rx="3" width="${totalWidth}" height="20" fill="url(#s)"/>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelX}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelX}" y="14">${label}</text>
    <text x="${valueX}" y="15" fill="#010101" fill-opacity=".3">${value}</text>
    <text x="${valueX}" y="14">${value}</text>
  </g>
</svg>`;
}

// Normalize and pretty-print any coverage-summary.json files the test
// run produced (vitest emits minified JSON with absolute paths, which
// we can't commit — see scripts/normalize-coverage-summary.mjs).
for (const [pkgPath] of packageDirs) {
  const summaryPath = resolve(root, pkgPath, "coverage/coverage-summary.json");
  normalizeSummaryFile(summaryPath);
}

const results = [];

for (const [pkgPath, name] of packageDirs) {
  const summaryPath = resolve(root, pkgPath, "coverage/coverage-summary.json");
  let pct = null;
  try {
    const data = JSON.parse(readFileSync(summaryPath, "utf8"));
    pct = data.total.lines.pct;
  } catch {
    // No coverage data — skip but still emit a badge
    pct = 0;
  }

  const value = `${pct}%`;
  const color = badgeColor(pct);
  const svg = makeSvg("coverage", value, color);
  const outPath = resolve(badgesDir, `coverage-${name}.svg`);
  writeFileSync(outPath, svg, "utf8");
  console.log(`  coverage-${name}.svg  ${value}`);
  results.push(pct);
}

// Combined badge: average across all packages
const avg =
  results.length > 0
    ? Math.round((results.reduce((a, b) => a + b, 0) / results.length) * 10) /
      10
    : 0;
const combinedSvg = makeSvg("coverage", `${avg}%`, badgeColor(avg));
writeFileSync(resolve(badgesDir, "coverage.svg"), combinedSvg, "utf8");
console.log(`  coverage.svg  ${avg}% (avg)`);
