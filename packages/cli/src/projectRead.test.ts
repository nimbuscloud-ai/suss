import { describe, expect, it } from "vitest";

import { commandFor, extractEntryFor } from "./projectRead.js";

import type { ReadEntry } from "./projectRead.js";

const reads: ReadEntry[] = [
  {
    kind: "extract",
    language: "typescript",
    dir: "server",
    project: "server/tsconfig.json",
    packs: ["nestjs-rest"],
  },
  { kind: "extract", language: "typescript", packs: ["react", "fetch"] },
  { kind: "extract", language: "python", dir: "api", packs: ["fastapi"] },
];

describe("reading what suss.json lists", () => {
  it("prefers the root's own entry for a command run at the root", () => {
    expect(extractEntryFor(reads, "typescript")?.packs).toEqual([
      "react",
      "fetch",
    ]);
  });

  it("falls back to a folder's entry when the root has none in that language", () => {
    expect(extractEntryFor(reads, "python")?.dir).toBe("api");
  });

  it("says which folder an entry reads in the command it prints", () => {
    expect(commandFor(reads[0] as ReadEntry)).toBe(
      "suss extract --lang typescript --dir server -p server/tsconfig.json -f nestjs-rest",
    );
  });
});
