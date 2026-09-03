import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";

import { packageExportsFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const created: string[] = [];

afterAll(() => {
  for (const root of created.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeWorkspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-pkg-exports-"));
  created.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}

async function extractWorkspace(): Promise<BehavioralSummary[]> {
  const root = writeWorkspace({
    "package.json": JSON.stringify({
      name: "demo-root",
      private: true,
      workspaces: ["packages/*"],
    }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "es2022",
        module: "esnext",
        moduleResolution: "bundler",
        strict: true,
      },
      include: ["packages/**/*.ts"],
    }),
    "packages/greeter/package.json": JSON.stringify({
      name: "@demo/greeter",
      main: "src/index.ts",
    }),
    "packages/greeter/src/index.ts": `
      export function greet(name: string): string {
        return "hello " + name;
      }

      export function createAdapterStamp(config: { moduleUrl: string }) {
        function codeStamp(): string {
          return config.moduleUrl;
        }
        function packsDigest(): string {
          return codeStamp();
        }
        return { codeStamp, packsDigest };
      }

      export function messageSends(spec: { wire: string }) {
        return chainFrom({ wire: spec.wire });
      }

      function chainFrom(declared: { wire: string }) {
        return {
          declared,
          methods: (table: unknown) => chainFrom(declared),
        };
      }
    `,
    "packages/app/package.json": JSON.stringify({
      name: "@demo/app",
      main: "src/main.ts",
    }),
    "packages/app/src/main.ts": `
      import { createAdapterStamp, greet, messageSends } from "@demo/greeter";

      export function run(): string {
        return greet("world");
      }

      const stamp = createAdapterStamp({ moduleUrl: "demo" });

      export function useStamp(): string {
        return stamp.packsDigest();
      }

      const sends = messageSends({ wire: "http" });

      export function useSends(): unknown {
        return sends.methods(null);
      }
    `,
  });

  const adapter = createTypeScriptAdapter({
    tsConfigFilePath: path.join(root, "tsconfig.json"),
    frameworks: [packageExportsFramework()],
    cacheDir: null,
  });
  return await adapter.extractAll();
}

describe("the package-exports pack over a workspace on disk", () => {
  it("marks both sides of the boundary between two workspace packages", async () => {
    const summaries = await extractWorkspace();

    const bindings = summaries
      .map((one) => one.identity.boundaryBinding)
      .filter((b) => b !== undefined && b !== null);
    const functionCalls = bindings.filter(
      (b) => b?.semantics.name === "function-call",
    );

    const provider = summaries.find(
      (one) =>
        one.identity.boundaryBinding?.semantics.name === "function-call" &&
        one.identity.boundaryBinding.semantics.package === "@demo/greeter" &&
        one.identity.boundaryBinding.semantics.exportPath?.includes("greet") &&
        one.identity.name.includes("greet"),
    );
    expect(provider).toBeDefined();
    expect(
      provider?.inputs.map((input) =>
        input.type === "parameter" ? input.name : input.type,
      ),
    ).toEqual(["name"]);
    expect(functionCalls.length).toBeGreaterThan(1);

    const consumer = summaries.find(
      (one) =>
        one.identity.boundaryBinding?.semantics.name === "function-call" &&
        one.identity.name.includes("run"),
    );
    expect(consumer).toBeDefined();
  }, 30000);

  it("pairs a consumer of a shorthand-surfaced factory method with its provider", async () => {
    const summaries = await extractWorkspace();

    const provider = summaries.find(
      (one) =>
        one.identity.boundaryBinding?.semantics.name === "function-call" &&
        one.identity.boundaryBinding.semantics.package === "@demo/greeter" &&
        exportPathOf(one)?.join(".") === "createAdapterStamp.packsDigest",
    );
    expect(provider).toBeDefined();

    const consumer = summaries.find(
      (one) =>
        one.identity.boundaryBinding?.semantics.name === "function-call" &&
        one.identity.name.includes("useStamp") &&
        exportPathOf(one)?.join(".") === "createAdapterStamp.packsDigest",
    );
    expect(consumer).toBeDefined();
  }, 30000);

  it("pairs a consumer of a factory method surfaced through a same-file helper with its provider", async () => {
    const summaries = await extractWorkspace();

    const provider = summaries.find(
      (one) =>
        one.identity.boundaryBinding?.semantics.name === "function-call" &&
        one.identity.boundaryBinding.semantics.package === "@demo/greeter" &&
        exportPathOf(one)?.join(".") === "messageSends.methods",
    );
    expect(provider).toBeDefined();

    const consumer = summaries.find(
      (one) =>
        one.identity.boundaryBinding?.semantics.name === "function-call" &&
        one.identity.name.includes("useSends") &&
        exportPathOf(one)?.join(".") === "messageSends.methods",
    );
    expect(consumer).toBeDefined();
  }, 30000);
});

function exportPathOf(summary: BehavioralSummary): string[] | undefined {
  const semantics = summary.identity.boundaryBinding?.semantics;
  return semantics && "exportPath" in semantics
    ? semantics.exportPath
    : undefined;
}
