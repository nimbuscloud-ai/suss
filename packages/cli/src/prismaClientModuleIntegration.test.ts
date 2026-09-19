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
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import honoFramework from "@suss/packs/hono";
import prismaFramework from "@suss/packs/prisma";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const repoRoot = path.resolve(__dirname, "../../..");

/** Both fixtures need a client that `PrismaClient: any` cannot stand in for. */
function generate(schema: string): void {
  execSync(`npx prisma generate --schema=${schema} --no-hints`, {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

async function storageReadsByFile(
  fixture: string,
): Promise<Map<string, string[]>> {
  const fixtureRoot = path.join(repoRoot, "fixtures", fixture);
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
});
