/**
 * The Prisma client reached from somewhere other than the file that
 * built it, through the shipped `prisma` and `hono` packs.
 *
 * `prisma-module` builds the client in `src/db.ts` and has two routes
 * import it, one straight and one through a barrel.
 * `prisma-generated-client` points the generator at a directory of its
 * own, so nothing imports "@prisma/client" and the client's types live
 * under the project rather than under node_modules.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Project, SyntaxKind } from "ts-morph";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createTypeScriptAdapter,
  methodDeclaredIn,
  ResolutionStore,
} from "@suss/adapter-typescript";
import honoFramework from "@suss/packs/hono";
import prismaFramework from "@suss/packs/prisma";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const repoRoot = path.resolve(__dirname, "../../..");

/** A project read with its own tsconfig, and a store that knows Prisma's generator. */
function readWithPrisma(projectRoot: string): {
  project: Project;
  store: ResolutionStore;
} {
  return {
    project: new Project({
      tsConfigFilePath: path.join(projectRoot, "tsconfig.json"),
    }),
    store: ResolutionStore.forPacks([prismaFramework()]),
  };
}

/** Both fixtures need a client that `PrismaClient: any` cannot stand in for. */
function generate(schema: string): void {
  execSync(`npx prisma generate --schema=${schema} --no-hints`, {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

function storageReadsByFile(fixture: string): Promise<Map<string, string[]>> {
  return storageReadsUnder(path.join(repoRoot, "fixtures", fixture));
}

async function storageReadsUnder(
  fixtureRoot: string,
): Promise<Map<string, string[]>> {
  const adapter = createTypeScriptAdapter({
    tsConfigFilePath: path.join(fixtureRoot, "tsconfig.json"),
    frameworks: [honoFramework(), prismaFramework()],
    cacheDir: null,
  });
  const summaries = await adapter.extractAll();
  const byFile = new Map<string, string[]>();
  for (const summary of summaries) {
    const file = path.relative(fixtureRoot, summary.location.file);
    const tables = byFile.get(file) ?? [];
    tables.push(...storageReadTables(summary));
    byFile.set(file, tables);
  }
  return byFile;
}

function storageReadTables(summary: BehavioralSummary): string[] {
  const tables: string[] = [];
  for (const transition of summary.transitions) {
    for (const effect of transition.effects) {
      if (effect.type !== "interaction") {
        continue;
      }
      const { binding, interaction } = effect as unknown as {
        binding: { semantics: { storageSystem?: string; container?: string } };
        interaction: { class: string; kind: string };
      };
      if (
        interaction.class !== "storage-access" ||
        interaction.kind !== "read"
      ) {
        continue;
      }
      tables.push(
        `${binding.semantics.storageSystem}:${binding.semantics.container}`,
      );
    }
  }
  return tables;
}

describe("a client another module built", () => {
  beforeAll(() => {
    generate(path.join(repoRoot, "fixtures/prisma/schema.prisma"));
  });

  it("reads User in the route that imports the client directly", async () => {
    const byFile = await storageReadsByFile("prisma-module");
    expect(byFile.get("src/direct.ts")).toEqual(["postgresql:User"]);
  });

  it("reads User in the route that imports the client through a barrel", async () => {
    const byFile = await storageReadsByFile("prisma-module");
    expect(byFile.get("src/barrel.ts")).toEqual(["postgresql:User"]);
  });
});

describe("a client the generator wrote into the project", () => {
  beforeAll(() => {
    generate(
      path.join(repoRoot, "fixtures/prisma-generated-client/schema.prisma"),
    );
  });

  it("reads User through a relative import no gate would match", async () => {
    const byFile = await storageReadsByFile("prisma-generated-client");
    expect(byFile.get("src/api.ts")).toEqual(["postgresql:User"]);
  });

  it("reads the generated client as @prisma/client, where it is made and where its methods are declared", () => {
    const fixtureRoot = path.join(repoRoot, "fixtures/prisma-generated-client");
    const { project, store } = readWithPrisma(fixtureRoot);
    const made = project
      .getSourceFileOrThrow(path.join(fixtureRoot, "src/db.ts"))
      .getFirstDescendantByKindOrThrow(SyntaxKind.NewExpression)
      .getExpression();
    const findUnique = project
      .getSourceFileOrThrow(path.join(fixtureRoot, "src/api.ts"))
      .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
      .find((access) => access.getName() === "findUnique");
    if (findUnique === undefined) {
      throw new Error("the fixture's route no longer calls findUnique");
    }

    expect(store.originatesFrom(made, "@prisma/client")).toBe(true);
    expect(
      methodDeclaredIn(
        findUnique,
        "@prisma/client",
        undefined,
        undefined,
        store.generatedModules,
      ),
    ).toBe(true);
    expect(methodDeclaredIn(findUnique, "@prisma/client")).toBe(false);
  });
});

describe("a client imported through the tsconfig's baseUrl, before the generator has run", () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-prisma-base-url-"));
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "base-url-app" }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: "./", moduleResolution: "node" },
        include: ["src/**/*.ts"],
      }),
      "prisma/schema.prisma": [
        "generator client {",
        '  provider = "prisma-client"',
        '  output   = "../src/generated/prisma"',
        "}",
        "",
        "model User {",
        "  id Int @id",
        "}",
        "",
      ].join("\n"),
      "src/prisma.service.ts": [
        'import { PrismaClient } from "src/generated/prisma/client";',
        "",
        "export class PrismaService extends PrismaClient {}",
        "",
      ].join("\n"),
      "src/app.ts": [
        'import { Hono } from "hono";',
        "",
        'import { PrismaService } from "src/prisma.service";',
        "",
        "const prisma = new PrismaService();",
        "const app = new Hono();",
        "",
        'app.get("/users", async (c) => c.json(await prisma.user.findMany()));',
        "",
        "export default app;",
        "",
      ].join("\n"),
    };
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    }
  });

  it("reads User through a class that extends the client", async () => {
    const byFile = await storageReadsUnder(root);
    expect(byFile.get("src/app.ts")).toEqual(["postgresql:User"]);
  });

  it("reads the class's base as @prisma/client's PrismaClient", () => {
    const { project, store } = readWithPrisma(root);
    const base = project
      .getSourceFileOrThrow(path.join(root, "src/prisma.service.ts"))
      .getFirstDescendantByKindOrThrow(SyntaxKind.ExpressionWithTypeArguments)
      .getExpression();

    expect(
      store.importOriginsOf(base, ["@prisma/client"]).map((one) => one.path),
    ).toEqual([["PrismaClient"]]);
  });
});
