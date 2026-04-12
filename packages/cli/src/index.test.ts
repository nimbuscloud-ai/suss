// index.test.ts — CLI tests (Task 4.1)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { extract } from "./extract.js";
import { inspect } from "./inspect.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_ROOT = path.resolve(__dirname, "../../../fixtures");

function createTempTsConfig(fixtureDir: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-test-"));
  const tsconfig = {
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: [path.join(fixtureDir, "**/*.ts")],
  };
  const tsconfigPath = path.join(tmpDir, "tsconfig.json");
  fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig));
  return tsconfigPath;
}

// ---------------------------------------------------------------------------
// extract — ts-rest fixtures
// ---------------------------------------------------------------------------

describe("extract — ts-rest", () => {
  const fixtureDir = path.join(FIXTURES_ROOT, "ts-rest");
  const tsconfigPath = createTempTsConfig(fixtureDir);

  it("extracts summaries from ts-rest fixture handlers", async () => {
    const summaries = await extract({
      tsconfig: tsconfigPath,
      frameworks: ["ts-rest"],
    });

    expect(summaries.length).toBeGreaterThan(0);
    for (const s of summaries) {
      expect(s.kind).toBeDefined();
      expect(s.identity).toBeDefined();
      expect(s.transitions).toBeDefined();
      expect(Array.isArray(s.transitions)).toBe(true);
    }
  });

  it("getUser handler has multiple transitions with status codes", async () => {
    const summaries = await extract({
      tsconfig: tsconfigPath,
      frameworks: ["ts-rest"],
    });

    const getUser = summaries.find((s) => s.identity.name === "getUser");
    if (getUser === undefined) {
      expect.unreachable("getUser handler not found");
    }
    expect(getUser.transitions.length).toBeGreaterThanOrEqual(3);

    // Should have both 200 and 404 responses
    const statusCodes = getUser.transitions
      .map((t) =>
        t.output.type === "response" && t.output.statusCode?.type === "literal"
          ? t.output.statusCode.value
          : null,
      )
      .filter((s) => s !== null);
    expect(statusCodes).toContain(200);
    expect(statusCodes).toContain(404);
  });

  it("detects gap for declared-but-unproduced 500 status", async () => {
    const summaries = await extract({
      tsconfig: tsconfigPath,
      frameworks: ["ts-rest"],
    });

    const getUser = summaries.find((s) => s.identity.name === "getUser");
    if (getUser === undefined) {
      expect.unreachable("getUser handler not found");
    }
    expect(getUser.gaps.length).toBeGreaterThan(0);

    const gapDescriptions = getUser.gaps.map((g) => g.description);
    expect(gapDescriptions.some((d) => d.includes("500"))).toBe(true);
  });

  it("writes output to file when -o is specified", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-out-"));
    const outPath = path.join(tmpDir, "output.json");

    await extract({
      tsconfig: tsconfigPath,
      frameworks: ["ts-rest"],
      output: outPath,
    });

    expect(fs.existsSync(outPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(outPath, "utf-8"));
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBeGreaterThan(0);

    // Clean up
    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// extract — express fixtures
// ---------------------------------------------------------------------------

describe("extract — express", () => {
  const fixtureDir = path.join(FIXTURES_ROOT, "express");
  const tsconfigPath = createTempTsConfig(fixtureDir);

  it("extracts handler summaries from express fixture", async () => {
    const summaries = await extract({
      tsconfig: tsconfigPath,
      frameworks: ["express"],
    });

    expect(summaries.length).toBeGreaterThan(0);

    // Should find res.status().json() terminals
    for (const s of summaries) {
      expect(s.transitions.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// extract — react-router fixtures
// ---------------------------------------------------------------------------

describe("extract — react-router", () => {
  const fixtureDir = path.join(FIXTURES_ROOT, "react-router");
  const tsconfigPath = createTempTsConfig(fixtureDir);

  it("extracts loader and action from react-router fixture", async () => {
    const summaries = await extract({
      tsconfig: tsconfigPath,
      frameworks: ["react-router"],
    });

    expect(summaries.length).toBeGreaterThan(0);

    const kinds = summaries.map((s) => s.kind);
    expect(kinds).toContain("loader");
    expect(kinds).toContain("action");
  });
});

// ---------------------------------------------------------------------------
// extract — error cases
// ---------------------------------------------------------------------------

describe("extract — errors", () => {
  it("throws on missing tsconfig", async () => {
    await expect(
      extract({
        tsconfig: "/nonexistent/tsconfig.json",
        frameworks: ["express"],
      }),
    ).rejects.toThrow("tsconfig not found");
  });

  it("throws on unknown framework", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-test-"));
    const tsconfigPath = path.join(tmpDir, "tsconfig.json");
    fs.writeFileSync(tsconfigPath, JSON.stringify({ compilerOptions: {} }));

    await expect(
      extract({
        tsconfig: tsconfigPath,
        frameworks: ["nonexistent-framework"],
      }),
    ).rejects.toThrow("Unknown framework");

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("throws on empty frameworks list", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-test-"));
    const tsconfigPath = path.join(tmpDir, "tsconfig.json");
    fs.writeFileSync(tsconfigPath, JSON.stringify({ compilerOptions: {} }));

    await expect(
      extract({
        tsconfig: tsconfigPath,
        frameworks: [],
      }),
    ).rejects.toThrow("At least one framework");

    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

describe("inspect", () => {
  it("formats summaries JSON to human-readable output", async () => {
    // First extract, then inspect the output
    const fixtureDir = path.join(FIXTURES_ROOT, "ts-rest");
    const tsconfigPath = createTempTsConfig(fixtureDir);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-inspect-"));
    const outPath = path.join(tmpDir, "summaries.json");

    await extract({
      tsconfig: tsconfigPath,
      frameworks: ["ts-rest"],
      output: outPath,
    });

    // Capture stdout
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      inspect({ file: outPath });
    } finally {
      process.stdout.write = origWrite;
    }

    const output = chunks.join("");
    expect(output).toContain("getUser");
    expect(output).toContain("summaries inspected");

    // Clean up
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("throws on nonexistent file", () => {
    expect(() => inspect({ file: "/nonexistent/file.json" })).toThrow(
      "File not found",
    );
  });
});
