#!/usr/bin/env node
/**
 * renderSiteAssets.mts: render docs/public/favicon.ico and docs/public/og.png
 * from docs/public/mark.svg, so the two raster assets stay derived from the
 * one vector mark instead of drifting as hand-edited PNGs.
 *
 * The favicon is the mark alone, rasterized at 16, 32 and 48 pixels and
 * packed into one .ico. The Open Graph image is the mark next to the
 * wordmark and a one-line description, composed as a second SVG and
 * rendered once. Both go through resvg, which needs its own font files
 * since it does not read the system font list here.
 *
 * Run with:
 *
 *   npx tsx scripts/renderSiteAssets.mts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Resvg } from "@resvg/resvg-js";
import pngToIco from "png-to-ico";
import { decompress as decompressWoff2 } from "wawoff2";

const ROOT = path.resolve(import.meta.dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "docs", "public");

const MARK_SVG = fs.readFileSync(path.join(PUBLIC_DIR, "mark.svg"), "utf8");

// The vitepress default theme ships an Inter variable font, but only as a
// single roman weight axis with no dedicated 700 file, so resvg has nothing
// unambiguous to select. @fontsource/inter ships one static file per weight,
// but only as woff/woff2; resvg's bundled fontdb can only read bare sfnt
// (ttf/otf), so each file is decompressed to sfnt before resvg sees it.
const FONT_TMP_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "suss-site-assets-"),
);

async function sfntFromWoff2(fontsourceFile: string): Promise<string> {
  const woff2 = fs.readFileSync(
    path.join(ROOT, "node_modules/@fontsource/inter/files", fontsourceFile),
  );
  const sfnt = await decompressWoff2(woff2);
  const outPath = path.join(
    FONT_TMP_DIR,
    fontsourceFile.replace(/\.woff2$/, ".ttf"),
  );
  fs.writeFileSync(outPath, sfnt);
  return outPath;
}

const INTER_BOLD = await sfntFromWoff2("inter-latin-700-normal.woff2");
const INTER_REGULAR = await sfntFromWoff2("inter-latin-400-normal.woff2");

async function renderFavicon(): Promise<Buffer> {
  const pngs = [16, 32, 48].map((size) => {
    const resvg = new Resvg(MARK_SVG, {
      fitTo: { mode: "width", value: size },
      font: { loadSystemFonts: false },
    });
    return resvg.render().asPng();
  });

  return pngToIco(pngs);
}

function renderOgImage(): Buffer {
  const width = 1200;
  const height = 630;
  const markSize = 200;
  const markX = 100;
  // Shifted above the arithmetic middle: the subtitle's descenders sit
  // below the mark, so centering only the mark reads as too low.
  const markY = 181;
  const textX = markX + markSize + 40;

  // Nest the mark's own <svg> so its viewBox, fill and stroke attributes
  // carry over untouched instead of being reconstructed by hand here.
  const nestedMark = MARK_SVG.replace(
    '<svg xmlns="http://www.w3.org/2000/svg"',
    `<svg xmlns="http://www.w3.org/2000/svg" x="${markX}" y="${markY}" width="${markSize}" height="${markSize}"`,
  );

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  ${nestedMark}
  <text x="${textX}" y="${markY + markSize / 2}" dominant-baseline="central" font-family="Inter" font-weight="700" font-size="140" fill="#213547">suss</text>
  <text x="${markX}" y="${markY + markSize + 60}" font-family="Inter" font-weight="400" font-size="30" fill="#213547">Reads your code and checks what it does at every boundary.</text>
</svg>`;

  const resvg = new Resvg(svg, {
    font: {
      loadSystemFonts: false,
      fontFiles: [INTER_BOLD, INTER_REGULAR],
      defaultFontFamily: "Inter",
    },
  });

  return resvg.render().asPng();
}

fs.writeFileSync(path.join(PUBLIC_DIR, "favicon.ico"), await renderFavicon());
fs.writeFileSync(path.join(PUBLIC_DIR, "og.png"), renderOgImage());
fs.rmSync(FONT_TMP_DIR, { recursive: true, force: true });

console.log("Wrote docs/public/favicon.ico and docs/public/og.png");
