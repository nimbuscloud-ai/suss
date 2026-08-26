import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { Project, worthRebuilding } from "./project.js";

function projectWithOneRoute(root: string, routePath: string): void {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
      },
      include: ["src"],
    }),
  );
  fs.writeFileSync(
    path.join(root, "src/app.ts"),
    [
      'import express from "express";',
      "const app = express();",
      `app.get("${routePath}", (req, res) => {`,
      "  res.status(200).json({ ok: true });",
      "});",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "suss.json"),
    JSON.stringify({
      version: 1,
      read: [
        {
          kind: "extract",
          language: "typescript",
          project: "tsconfig.json",
          packs: ["express"],
        },
      ],
    }),
  );
}

/** Every boundary the summaries in a directory record. */
function boundariesIn(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) =>
      JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")),
    )
    .map(
      (summary: {
        identity: { boundaryBinding: { semantics: { path?: string } } | null };
      }) => summary.identity.boundaryBinding?.semantics.path ?? "",
    )
    .filter((one) => one !== "");
}

/**
 * Poll until it is true, or give up and let the assertion report what
 * it found. The budget is generous because a rebuild waits out its
 * debounce and then runs an extract, on a machine running the rest of
 * the suite at the same time.
 */
async function waitFor(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (done()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("Project", () => {
  it("runs what suss.json says and reports what ran", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-proj-"));
    projectWithOneRoute(root, "/orders");
    const project = new Project({ root, watch: false });
    const report = await project.start();

    expect(report.configured).toBe(true);
    expect(report.ran).toEqual(["extract --lang typescript -f express"]);
    expect(report.failed).toEqual([]);
    expect(boundariesIn(report.summaryDir)).toEqual(["/orders"]);

    project.close();
    fs.rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it("picks up an edit, so an answer describes the tree as it is", async () => {
    // The reason the server watches at all: a model asking a question
    // in the round right after it wrote the code gets an answer about
    // what it wrote, not about the last time somebody ran extract.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-proj-watch-"));
    projectWithOneRoute(root, "/orders");
    const project = new Project({ root, watch: false });
    await project.start();
    expect(boundariesIn(project.summaryDir)).toEqual(["/orders"]);

    projectWithOneRoute(root, "/invoices");
    await project.build();
    expect(boundariesIn(project.summaryDir)).toEqual(["/invoices"]);

    project.close();
    fs.rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it("keeps going when one of the commands throws", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-proj-partial-"));
    projectWithOneRoute(root, "/orders");
    fs.writeFileSync(
      path.join(root, "suss.json"),
      JSON.stringify({
        version: 1,
        read: [
          {
            kind: "extract",
            language: "typescript",
            project: "tsconfig.json",
            packs: ["express"],
          },
          { kind: "contract", from: "openapi", file: "nothing-here.yaml" },
        ],
      }),
    );

    const project = new Project({ root, watch: false });
    const report = await project.start();

    // A project with one unreadable spec should still answer questions
    // about the code suss could read.
    expect(report.ran).toHaveLength(1);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toContain("nothing-here.yaml");
    expect(boundariesIn(report.summaryDir)).toEqual(["/orders"]);

    project.close();
    fs.rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it("starts a rebuild on its own when a source file changes", async () => {
    // This is why the server watches rather than extracting once. An
    // agent edits a file and asks a question seconds later, and the
    // answer has to describe what it wrote.
    //
    // What this checks is the wiring: the watcher fires, the filter
    // takes the file, the debounce elapses, and a build runs. What that
    // build produces is checked above, by calling build() directly,
    // because an extract racing the rest of the suite is not something
    // this test should be measuring.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-proj-live-"));
    projectWithOneRoute(root, "/orders");
    const project = new Project({ root, watch: true });
    const first = await project.start();

    // A recursive watch takes a moment to arm on macOS, and a write in
    // that window is missed. A server in use has been running long
    // before anybody edits anything, so waiting here matches how it is
    // actually used rather than papering over a race.
    await new Promise((resolve) => setTimeout(resolve, 500));

    projectWithOneRoute(root, "/invoices");
    await waitFor(() => project.lastBuild() !== first);
    expect(project.lastBuild()).not.toBe(first);

    project.close();
    fs.rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it("says a project with no suss.json is not configured", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-proj-bare-"));
    const project = new Project({ root, watch: false });
    const report = await project.start();

    expect(report.configured).toBe(false);
    expect(report.ran).toEqual([]);

    project.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("worthRebuilding", () => {
  it("takes a source file", () => {
    expect(worthRebuilding(path.join("src", "app.ts"))).toBe(true);
    expect(worthRebuilding(path.join("api", "openapi.yaml"))).toBe(true);
    expect(worthRebuilding(path.join("app", "handler.py"))).toBe(true);
  });

  it("leaves the directories that never stop changing", () => {
    // A watcher that rebuilt on these would never stop rebuilding.
    for (const noisy of ["node_modules", "dist", ".git", ".next", "build"]) {
      expect(worthRebuilding(path.join(noisy, "thing", "index.ts"))).toBe(
        false,
      );
    }
  });

  it("leaves a file a rebuild would read the same", () => {
    expect(worthRebuilding(path.join("docs", "guide.md"))).toBe(false);
    expect(worthRebuilding(path.join("src", "logo.png"))).toBe(false);
  });
});
