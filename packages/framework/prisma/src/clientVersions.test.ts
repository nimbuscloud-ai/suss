/**
 * The client as each Prisma version leaves it on disk, run through the
 * adapter with a pack that makes every exported function a unit. Each
 * project is written to a temporary directory, since the import gate
 * and the schema lookup both read files.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";

import { generatedClientDirs } from "./generatedClient.js";
import { prismaFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function projectOf(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-prisma-version-"));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    skipLibCheck: true,
  },
  include: ["src/**/*.ts"],
});

const MODEL = `
model Order {
  id        Int    @id @default(autoincrement())
  reference String @unique
  total     Int
}
`;

const DATASOURCE = `
datasource db {
  provider = "postgresql"
}
`;

const ORDERS = (from: string) => `
import { PrismaClient } from "${from}";

const db = new PrismaClient();

export async function read(reference: string) {
  return db.order.findUnique({ where: { reference }, select: { id: true } });
}

export async function write(reference: string) {
  return db.order.create({ data: { reference, total: 1 } });
}
`;

const DELEGATE = `
export interface OrderDelegate {
  findUnique(args: unknown): Promise<unknown>;
  create(args: unknown): Promise<unknown>;
}
`;

/** `@prisma/client` as npm installs it, with `.prisma/client` giving `default`. */
function installedClient(defaultTypes: string): Record<string, string> {
  return {
    "node_modules/@prisma/client/package.json": JSON.stringify({
      name: "@prisma/client",
      types: "index.d.ts",
    }),
    "node_modules/@prisma/client/index.d.ts":
      'export * from ".prisma/client/default";',
    "node_modules/.prisma/client/default.d.ts": defaultTypes,
  };
}

const EXPORTED_FUNCTIONS: PatternPack = {
  name: "exported-functions",
  protocol: "in-process",
  languages: ["typescript"],
  discovery: [
    {
      kind: "handler",
      match: { type: "namedExport", names: ["read", "write"] },
    },
  ],
  terminals: [
    {
      kind: "return",
      match: { type: "returnStatement" },
      extraction: {},
    },
  ],
  inputMapping: { type: "positionalParams", params: [] },
};

/** Each unit's name with the model and kind of every storage access it makes. */
async function accessesIn(root: string): Promise<Record<string, string[]>> {
  const adapter = createTypeScriptAdapter({
    tsConfigFilePath: path.join(root, "tsconfig.json"),
    frameworks: [EXPORTED_FUNCTIONS, prismaFramework()],
    cacheDir: null,
  });
  const summaries: BehavioralSummary[] = await adapter.extractAll();
  const found: Record<string, string[]> = {};
  for (const summary of summaries) {
    const accesses: string[] = [];
    for (const transition of summary.transitions) {
      for (const effect of transition.effects) {
        if (
          effect.type === "interaction" &&
          effect.interaction.class === "storage-access" &&
          effect.binding.semantics.name === "storage"
        ) {
          accesses.push(
            `${effect.interaction.kind} ${effect.binding.semantics.container}`,
          );
        }
      }
    }
    found[summary.identity.name] = accesses;
  }
  return found;
}

const READ_AND_WRITE = { read: ["read Order"], write: ["write Order"] };

describe("a Prisma client on each version", () => {
  it("reads a Prisma 5 client that was never generated, whose type is any", async () => {
    const root = projectOf({
      "package.json": JSON.stringify({ name: "orders" }),
      "tsconfig.json": TSCONFIG,
      "prisma/schema.prisma": DATASOURCE + MODEL,
      ...installedClient("export declare const PrismaClient: any;"),
      "src/orders.ts": ORDERS("@prisma/client"),
    });
    expect(await accessesIn(root)).toEqual(READ_AND_WRITE);
  }, 60_000);

  const NEVER_GENERATED = {
    "package.json": JSON.stringify({ name: "orders" }),
    "tsconfig.json": TSCONFIG,
    "prisma/schema.prisma": DATASOURCE + MODEL,
    ...installedClient("export declare const PrismaClient: any;"),
    "src/lib/db.ts":
      'import { PrismaClient } from "@prisma/client";\nexport const db = new PrismaClient();\n',
    "src/lib/index.ts": 'export { db } from "./db";\n',
  };

  const ORDERS_USING = (from: string) => `
import { db } from "${from}";

export async function read(reference: string) {
  return db.order.findUnique({ where: { reference }, select: { id: true } });
}

export async function write(reference: string) {
  return db.order.create({ data: { reference, total: 1 } });
}
`;

  it("reads a never-generated client that another file makes and exports", async () => {
    const root = projectOf({
      ...NEVER_GENERATED,
      "src/orders.ts": ORDERS_USING("./lib/db"),
    });
    expect(await accessesIn(root)).toEqual(READ_AND_WRITE);
  }, 60_000);

  it("reads a never-generated client that reaches the handler through a barrel", async () => {
    const root = projectOf({
      ...NEVER_GENERATED,
      "src/orders.ts": ORDERS_USING("./lib"),
    });
    expect(await accessesIn(root)).toEqual(READ_AND_WRITE);
  }, 60_000);

  it("leaves a client of any type alone when it was made from something else", async () => {
    const root = projectOf({
      "package.json": JSON.stringify({ name: "orders" }),
      "tsconfig.json": TSCONFIG,
      ...installedClient("export declare const PrismaClient: any;"),
      "src/fake.ts": "export const PrismaClient: any = class {};",
      "src/orders.ts": `import "@prisma/client";\n${ORDERS("./fake")}`,
    });
    expect(await accessesIn(root)).toEqual({ read: [], write: [] });
  }, 60_000);

  it("reads a Prisma 5 client after prisma generate", async () => {
    const root = projectOf({
      "package.json": JSON.stringify({ name: "orders" }),
      "tsconfig.json": TSCONFIG,
      "prisma/schema.prisma": `generator client {\n  provider = "prisma-client-js"\n}\n${DATASOURCE}${MODEL}`,
      ...installedClient(
        `${DELEGATE}\nexport declare class PrismaClient { readonly order: OrderDelegate; }`,
      ),
      "src/orders.ts": ORDERS("@prisma/client"),
    });
    expect(await accessesIn(root)).toEqual(READ_AND_WRITE);
  }, 60_000);

  const PRISMA_7 = {
    "package.json": JSON.stringify({ name: "orders" }),
    "tsconfig.json": TSCONFIG,
    "prisma.config.ts":
      'import { defineConfig } from "prisma/config";\nexport default defineConfig({ schema: "db/schema.prisma" });\n',
    "db/schema.prisma": `generator client {\n  provider = "prisma-client"\n  output   = "../src/generated/prisma"\n}\n${DATASOURCE}${MODEL}`,
    "src/orders.ts": ORDERS("./generated/prisma/client"),
  };

  it("reads a Prisma 7 client the prisma-client generator wrote where the schema says", async () => {
    const root = projectOf({
      ...PRISMA_7,
      "src/generated/prisma/client.ts": `import * as $Class from "./internal/class";\nexport const PrismaClient = $Class.getPrismaClientClass();\nexport type PrismaClient = $Class.PrismaClient;\n`,
      "src/generated/prisma/internal/class.ts": `${DELEGATE}\nexport interface PrismaClient { readonly order: OrderDelegate }\nexport interface PrismaClientConstructor { new (): PrismaClient }\nexport declare function getPrismaClientClass(): PrismaClientConstructor;\n`,
    });
    expect(await accessesIn(root)).toEqual(READ_AND_WRITE);
  }, 60_000);

  it("reads a Prisma 7 client before the generator has written anything", async () => {
    const root = projectOf(PRISMA_7);
    expect(await accessesIn(root)).toEqual(READ_AND_WRITE);
  }, 60_000);

  it("reads a project's class over a Prisma 7 client before the generator has written anything", async () => {
    const root = projectOf({
      ...PRISMA_7,
      "src/orders.ts": `
import { PrismaClient } from "./generated/prisma/client";

class Db extends PrismaClient {}

const db = new Db();

export async function read(reference: string) {
  return db.order.findUnique({ where: { reference }, select: { id: true } });
}

export async function write(reference: string) {
  return db.order.create({ data: { reference, total: 1 } });
}
`,
    });
    expect(await accessesIn(root)).toEqual(READ_AND_WRITE);
  }, 60_000);
});

describe("generatedClientDirs", () => {
  const GENERATOR = (output: string) =>
    `generator client {\n  provider = "prisma-client"\n  output   = "${output}"\n}\n`;

  it("reads the schema a Prisma config gives", () => {
    const root = projectOf({
      "package.json": "{}",
      "prisma.config.ts": 'export default { schema: "db/app.prisma" };',
      "db/app.prisma": GENERATOR("../gen"),
      "src/deep/file.ts": "",
    });
    expect(generatedClientDirs(path.join(root, "src/deep"))).toEqual([
      path.join(root, "gen"),
    ]);
  });

  it("reads the schema package.json gives, then the default places", () => {
    const fromPackage = projectOf({
      "package.json": JSON.stringify({
        prisma: { schema: "schemas/main.prisma" },
      }),
      "schemas/main.prisma": GENERATOR("./client"),
    });
    expect(generatedClientDirs(fromPackage)).toEqual([
      path.join(fromPackage, "schemas/client"),
    ]);
    const byDefault = projectOf({
      "package.json": "{}",
      "schema.prisma": GENERATOR("./client"),
    });
    expect(generatedClientDirs(byDefault)).toEqual([
      path.join(byDefault, "client"),
    ]);
  });

  it("reads every file of a schema split across a directory", () => {
    const root = projectOf({
      "package.json": "{}",
      "prisma.config.ts": 'export default { schema: "prisma" };',
      "prisma/a.prisma": GENERATOR("../one"),
      "prisma/nested/b.prisma": GENERATOR("../../two"),
    });
    expect(generatedClientDirs(root)).toEqual([
      path.join(root, "one"),
      path.join(root, "two"),
    ]);
  });

  it("skips an output read from the environment and a schema that does not parse", () => {
    const root = projectOf({
      "package.json": "{}",
      "prisma/schema.prisma":
        'generator client {\n  provider = "prisma-client"\n  output   = env("OUT")\n}\n',
    });
    expect(generatedClientDirs(root)).toEqual([]);
    const broken = projectOf({
      "package.json": "{}",
      "prisma/schema.prisma": "generator client { provider",
    });
    expect(generatedClientDirs(broken)).toEqual([]);
  });

  it("walks up to the project once per directory", () => {
    const root = projectOf({
      "package.json": "{}",
      "prisma/schema.prisma": GENERATOR("../gen"),
      "src/a/b/c/file.ts": "",
    });
    const deep = path.join(root, "src/a/b/c");
    expect(generatedClientDirs(deep)).toEqual([path.join(root, "gen")]);
    const existsSync = vi.spyOn(fs, "existsSync");
    try {
      expect(generatedClientDirs(deep)).toEqual([path.join(root, "gen")]);
      expect(existsSync).not.toHaveBeenCalled();
    } finally {
      existsSync.mockRestore();
    }
  });

  it("reads the schema again once it changes", () => {
    const root = projectOf({
      "package.json": "{}",
      "prisma/schema.prisma": GENERATOR("../first"),
    });
    expect(generatedClientDirs(root)).toEqual([path.join(root, "first")]);
    const schema = path.join(root, "prisma/schema.prisma");
    fs.writeFileSync(schema, GENERATOR("../second"));
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(schema, later, later);
    expect(generatedClientDirs(root)).toEqual([path.join(root, "second")]);
  });
});
