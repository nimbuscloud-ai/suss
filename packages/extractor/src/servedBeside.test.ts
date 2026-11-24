import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  functionCallBinding,
  readServedBesideMetadata,
  restBinding,
} from "@suss/behavioral-ir";

import { stampServedBeside, staticDirectoryEntries } from "./servedBeside.js";

import type { BehavioralSummary, BoundaryBinding } from "@suss/behavioral-ir";

function unit(
  kind: BehavioralSummary["kind"],
  binding: BoundaryBinding,
): BehavioralSummary {
  return {
    kind,
    location: { file: "app.ts", range: { start: 1, end: 2 }, exportName: null },
    identity: { name: kind, exportPath: null, boundaryBinding: binding },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

const route = (recognition: string) =>
  unit(
    "handler",
    restBinding({
      transport: "http",
      recognition,
      method: "GET",
      path: "/orders",
    }),
  );

describe("a pack's statement of what serves requests beside its routes", () => {
  it("goes on each unit the pack recognized that serves a boundary, and nowhere else", () => {
    const own = route("shop-framework");
    const other = route("other-framework");
    const call = unit(
      "client",
      restBinding({
        transport: "http",
        recognition: "shop-framework",
        method: "GET",
        path: "/orders",
      }),
    );
    const helper = unit(
      "library",
      functionCallBinding({ transport: "in-process", recognition: "other" }),
    );
    const entries = [
      { by: "rewrite" as const, path: "/old/{path*}", file: "a.ts", line: 2 },
    ];

    stampServedBeside([own, other, call, helper], "shop-framework", entries);

    expect(readServedBesideMetadata(own)).toEqual({
      pack: "shop-framework",
      entries,
    });
    expect(readServedBesideMetadata(other)).toBeUndefined();
    expect(readServedBesideMetadata(call)).toBeUndefined();
    expect(readServedBesideMetadata(helper)).toBeUndefined();
  });
});

describe("the files a static directory serves", () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-static-"));
    fs.mkdirSync(path.join(root, "public", "Images"), { recursive: true });
    fs.writeFileSync(path.join(root, "public", "Robots.txt"), "");
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("lists a file at its own path and a directory as every path under it, for GET", () => {
    const entries = staticDirectoryEntries(root, ["public", "missing"]);

    expect(entries.map((entry) => [entry.path, entry.methods]).sort()).toEqual([
      ["/images/{rest*}", ["GET", "HEAD"]],
      ["/robots.txt", ["GET", "HEAD"]],
    ]);
  });
});
