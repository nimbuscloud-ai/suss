#!/usr/bin/env node
// checkDiagrams.mjs — catch diagram collisions before a reader does.
//
// The diagrams in docs/ are hand-authored SVG, which buys layout control
// and costs the guarantee that a label fits where it was put. Two
// mistakes shipped before this existed: a subtitle wider than its box,
// and a connector routed straight through another box.
//
// So the geometry gets checked: every label inside the frame, every
// label inside its own box rather than lying across a neighbour's, and
// no connector crossing a box it does not start or end at.
//
// Text width is estimated from a per-class average character width,
// since there is no font engine here. The estimate runs slightly wide,
// which is the direction that fails safe.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCS = path.join(ROOT, "docs");

/** Average character width in pixels, by the class on the text element. */
const CHAR_WIDTH = {
  label: 7.1,
  "label-mono": 7.3,
  note: 5.7,
  axis: 7.4,
};

function* markdownFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* markdownFiles(full);
    } else if (entry.name.endsWith(".md")) {
      yield full;
    }
  }
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`));
  return match === null ? null : match[1];
}

function num(tag, name, fallback = 0) {
  const raw = attr(tag, name);
  return raw === null ? fallback : Number.parseFloat(raw);
}

/** Where a text element's box sits, given its anchor. */
function textBounds(tag, content) {
  const classes = (attr(tag, "class") ?? "").split(/\s+/);
  const perChar = CHAR_WIDTH[classes[0]] ?? 7;
  const width = content.length * perChar;
  const anchor = attr(tag, "text-anchor") ?? "start";
  const x = num(tag, "x");
  const y = num(tag, "y");
  const left =
    anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
  // A baseline sits roughly three quarters down the glyph box.
  const fontSize = classes[0] === "label" ? 13 : 11;
  return {
    left,
    right: left + width,
    top: y - fontSize * 0.75,
    bottom: y + fontSize * 0.25,
    content,
  };
}

function overlaps(a, b) {
  return (
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  );
}

function contains(outer, inner) {
  return (
    inner.left >= outer.left - 1 &&
    inner.right <= outer.right + 1 &&
    inner.top >= outer.top - 1 &&
    inner.bottom <= outer.bottom + 1
  );
}

/** Every point a line or path passes through, as segment endpoints. */
function segmentsOf(tag) {
  if (tag.startsWith("<line")) {
    return [
      [
        { x: num(tag, "x1"), y: num(tag, "y1") },
        { x: num(tag, "x2"), y: num(tag, "y2") },
      ],
    ];
  }
  const d = attr(tag, "d");
  if (d === null) {
    return [];
  }
  const points = [];
  for (const command of d.matchAll(/([ML])\s*(-?[\d.]+),(-?[\d.]+)/g)) {
    points.push({
      x: Number.parseFloat(command[2]),
      y: Number.parseFloat(command[3]),
    });
  }
  const segments = [];
  for (let i = 1; i < points.length; i++) {
    segments.push([points[i - 1], points[i]]);
  }
  return segments;
}

/** Does an axis-aligned segment pass through the interior of a box? */
function segmentCrossesBox([a, b], box) {
  const margin = 3;
  const inner = {
    left: box.left + margin,
    right: box.right - margin,
    top: box.top + margin,
    bottom: box.bottom - margin,
  };
  if (a.x === b.x) {
    const [lo, hi] = a.y < b.y ? [a.y, b.y] : [b.y, a.y];
    return (
      a.x > inner.left &&
      a.x < inner.right &&
      lo < inner.bottom &&
      hi > inner.top
    );
  }
  if (a.y === b.y) {
    const [lo, hi] = a.x < b.x ? [a.x, b.x] : [b.x, a.x];
    return (
      a.y > inner.top &&
      a.y < inner.bottom &&
      lo < inner.right &&
      hi > inner.left
    );
  }
  // Diagonal connectors are used to link boxes that sit apart, and
  // checking them properly needs real clipping. Left alone.
  return false;
}

const problems = [];

for (const file of markdownFiles(DOCS)) {
  const source = fs.readFileSync(file, "utf8");
  const relative = path.relative(ROOT, file);

  for (const svg of source.matchAll(
    /<svg class="suss-diagram"[\s\S]*?<\/svg>/g,
  )) {
    const body = svg[0];
    const viewBox = (attr(body, "viewBox") ?? "0 0 0 0")
      .split(/\s+/)
      .map(Number);
    const frame = {
      left: viewBox[0],
      top: viewBox[1],
      right: viewBox[0] + viewBox[2],
      bottom: viewBox[1] + viewBox[3],
    };
    const title = body.match(/<title[^>]*>([^<]*)<\/title>/)?.[1] ?? "untitled";

    const boxes = [...body.matchAll(/<rect[^>]*\/>/g)].map((m) => ({
      left: num(m[0], "x"),
      top: num(m[0], "y"),
      right: num(m[0], "x") + num(m[0], "width"),
      bottom: num(m[0], "y") + num(m[0], "height"),
    }));

    const texts = [...body.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)].map((m) =>
      textBounds(`<text${m[1]}>`, m[2]),
    );

    for (const text of texts) {
      if (!contains(frame, text)) {
        problems.push(
          `${relative} [${title}]\n  "${text.content}" runs outside the frame`,
        );
        continue;
      }
      const home = boxes.find((box) => contains(box, text));
      if (home !== undefined) {
        continue;
      }
      const crossed = boxes.find((box) => overlaps(box, text));
      if (crossed !== undefined) {
        problems.push(
          `${relative} [${title}]\n  "${text.content}" overflows the box it sits in, or lies across another`,
        );
      }
    }

    for (const connector of body.matchAll(
      /<(?:line|path)[^>]*class="arrow"[^>]*\/>/g,
    )) {
      for (const segment of segmentsOf(connector[0])) {
        const crossed = boxes.find((box) => segmentCrossesBox(segment, box));
        if (crossed !== undefined) {
          problems.push(
            `${relative} [${title}]\n  a connector runs through the box at (${crossed.left}, ${crossed.top})`,
          );
        }
      }
    }
  }
}

if (problems.length === 0) {
  process.stdout.write("Every diagram's labels and connectors sit clear.\n");
  process.exit(0);
}

for (const problem of problems) {
  process.stderr.write(`${problem}\n\n`);
}
process.stderr.write(
  `${problems.length} ${problems.length === 1 ? "collision" : "collisions"} in the diagrams.\n`,
);
process.exit(1);
