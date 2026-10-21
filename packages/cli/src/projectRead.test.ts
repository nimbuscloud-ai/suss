import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  commandFor,
  declaredReads,
  extractEntryFor,
  whereReadsCameFrom,
} from "./projectRead.js";

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

const MONOREPO = path.resolve(
  import.meta.dirname,
  "../../../fixtures/typescript-monorepo",
);

const copies: string[] = [];

afterEach(() => {
  for (const copy of copies.splice(0)) {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

/** A copy of the monorepo fixture with this `read` list in its suss.json. */
function monorepoWith(read: unknown[]): string {
  const root = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-project-read-")),
    "shop",
  );
  copies.push(path.dirname(root));
  fs.cpSync(MONOREPO, root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "suss.json"),
    JSON.stringify({ version: 1, read }),
  );
  return root;
}

const typescript = (packs: string[], more: object = {}) => ({
  kind: "extract",
  language: "typescript",
  packs,
  ...more,
});

describe("reading a suss.json that 0.34.0 wrote for a monorepo", () => {
  it("reads each package from its own folder when every tsconfig path says tsconfig.json", async () => {
    const root = monorepoWith([
      typescript(["axios", "fetch", "node"], { project: "tsconfig.json" }),
      typescript(["express", "fetch", "node"], { project: "tsconfig.json" }),
      typescript(["fetch", "node"], { project: "tsconfig.json" }),
    ]);

    const found = await declaredReads(root);

    expect(found.reads.map(commandFor)).toEqual([
      "suss extract --lang typescript -p tsconfig.json -f axios -f fetch -f node",
      "suss extract --lang typescript --dir packages/api -p packages/api/tsconfig.json -f express -f fetch -f node",
      "suss extract --lang typescript --dir packages/web -p packages/web/tsconfig.json -f fetch -f node",
    ]);
    expect(found.foldersFound).toBe(2);
  });

  it("finds the folder when the root has no tsconfig of its own", async () => {
    const root = monorepoWith([
      typescript(["express", "fetch", "node"], { project: "tsconfig.json" }),
      typescript(["fetch", "node"], { project: "tsconfig.json" }),
    ]);
    fs.rmSync(path.join(root, "tsconfig.json"));

    const found = await declaredReads(root);

    expect(found.reads).toEqual([
      typescript(["express", "fetch", "node"], {
        dir: "packages/api",
        project: "packages/api/tsconfig.json",
      }),
      typescript(["fetch", "node"], {
        dir: "packages/web",
        project: "packages/web/tsconfig.json",
      }),
    ]);
  });

  it("leaves an entry as written when no package has its packs", async () => {
    const root = monorepoWith([
      typescript(["hono"], { project: "tsconfig.json" }),
      typescript(["fetch", "node"], { project: "tsconfig.json" }),
    ]);

    const found = await declaredReads(root);

    expect(found.reads[0]).toEqual(
      typescript(["hono"], { project: "tsconfig.json" }),
    );
    expect(found.reads[1]).toMatchObject({ dir: "packages/web" });
    expect(found.foldersFound).toBe(1);
  });

  it("reads each Python and Ruby project from its own folder", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-project-read-"));
    copies.push(root);
    const fixtures = path.resolve(MONOREPO, "..");
    for (const [folder, fixture] of [
      ["admin", "ruby-graphql"],
      ["billing", "python-webapp"],
      ["orders", "python-webapp"],
      ["shop", "ruby-graphql"],
    ] as const) {
      fs.cpSync(path.join(fixtures, fixture), path.join(root, folder), {
        recursive: true,
      });
    }
    const ruby = (folder: string) => ({
      kind: "extract",
      language: "ruby",
      packs: [`graphql-ruby=${folder}/suss.graphql-ruby.json`, "net-http"],
    });
    const python = {
      kind: "extract",
      language: "python",
      packs: ["fastapi", "flask-restx"],
    };
    fs.writeFileSync(
      path.join(root, "suss.json"),
      JSON.stringify({
        version: 1,
        read: [ruby("admin"), python, python, ruby("shop")],
      }),
    );

    const found = await declaredReads(root);

    expect(
      found.reads.map((entry) =>
        entry.kind === "extract" ? `${entry.language} ${entry.dir}` : "",
      ),
    ).toEqual(["ruby admin", "python billing", "python orders", "ruby shop"]);
  });

  it("says how many reads it found a folder for, and how to write them down", () => {
    expect(whereReadsCameFrom("/shop", true, 2)).toContain(
      "It gives 2 reads without a folder, the way suss 0.34.0 wrote a monorepo",
    );
    expect(whereReadsCameFrom("/shop", true, 2)).toContain(
      "suss init --write --overwrite",
    );
  });
});

describe("reading a suss.json written from the root", () => {
  it("keeps the folders and tsconfig paths init writes now", async () => {
    const written = [
      typescript(["axios", "fetch", "node"], { project: "tsconfig.json" }),
      typescript(["express", "fetch", "node"], {
        dir: "packages/api",
        project: "packages/api/tsconfig.json",
      }),
    ];
    const root = monorepoWith(written);

    const found = await declaredReads(root);

    expect(found.reads).toEqual(written);
    expect(found.foldersFound).toBe(0);
  });

  it("keeps entries with no folder whose tsconfig path starts at the root", async () => {
    const written = [
      typescript(["express", "fetch", "node"], {
        project: "packages/api/tsconfig.json",
      }),
      typescript(["fetch", "node"], { project: "packages/web/tsconfig.json" }),
    ];
    const root = monorepoWith(written);

    const found = await declaredReads(root);

    expect(found.reads).toEqual(written);
  });
});
