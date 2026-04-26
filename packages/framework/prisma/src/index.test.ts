import {
  type CallExpression,
  Node,
  Project,
  ScriptTarget,
  type SourceFile,
} from "ts-morph";
import { describe, expect, it } from "vitest";

import { prismaFramework } from "./index.js";

import type { Effect } from "@suss/behavioral-ir";
import type { EffectArg } from "@suss/extractor";

const raise = (msg: string): never => {
  throw new Error(msg);
};

/**
 * Build an in-memory ts-morph Project with a minimal `@prisma/client`
 * .d.ts so the recognizer's type-resolution check finds the
 * PrismaClient symbol in the right source file. The fake type is
 * shaped enough that ts-morph can resolve `prisma.user.findUnique`
 * to the right delegate symbol.
 */
function makeProject(userSource: string): SourceFile {
  const project = new Project({
    compilerOptions: {
      target: ScriptTarget.ES2022,
      strict: true,
      moduleResolution: 100, // ts.ModuleResolutionKind.Bundler
    },
    useInMemoryFileSystem: true,
  });

  // Minimal @prisma/client surface — enough to give the symbol a
  // declaration in a file path containing "/@prisma/client/".
  project.createSourceFile(
    "node_modules/@prisma/client/index.d.ts",
    `
      export interface FindUniqueArgs<T> { where: T; select?: Record<string, boolean>; include?: Record<string, unknown>; }
      export interface FindManyArgs<T> { where?: T; select?: Record<string, boolean>; include?: Record<string, unknown>; }
      export interface CreateArgs<T> { data: T; }
      export interface UpdateArgs<W, T> { where: W; data: T; }
      export interface UpsertArgs<W, C, U> { where: W; create: C; update: U; }
      export interface DeleteArgs<T> { where: T; }
      export interface UserDelegate {
        findUnique(args: FindUniqueArgs<{ id?: number; email?: string }>): Promise<unknown>;
        findFirst(args: FindManyArgs<unknown>): Promise<unknown>;
        findMany(args?: FindManyArgs<unknown>): Promise<unknown>;
        count(args?: { where?: unknown }): Promise<number>;
        create(args: CreateArgs<{ email: string; name?: string }>): Promise<unknown>;
        update(args: UpdateArgs<{ id: number }, { name?: string }>): Promise<unknown>;
        upsert(args: UpsertArgs<{ id: number }, unknown, unknown>): Promise<unknown>;
        delete(args: DeleteArgs<{ id: number }>): Promise<unknown>;
      }
      export interface PostDelegate {
        findUnique(args: FindUniqueArgs<{ id: number }>): Promise<unknown>;
        create(args: CreateArgs<{ title: string; authorId: number }>): Promise<unknown>;
      }
      export class PrismaClient {
        readonly user: UserDelegate;
        readonly post: PostDelegate;
      }
    `,
  );

  return project.createSourceFile("user.ts", userSource);
}

function recognizeAll(sourceFile: SourceFile): Effect[] {
  const pack = prismaFramework();
  const recognizer = pack.invocationRecognizers?.[0] ?? raise("no recognizer");
  const effects: Effect[] = [];
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const ctx = {
      call: node as CallExpression,
      sourceFile,
      extractArgs: (): EffectArg[] => extractArgsForTest(node),
    };
    const emitted = recognizer(node, ctx);
    if (emitted !== null) {
      effects.push(...emitted);
    }
  });
  return effects;
}

/**
 * Tiny EffectArg builder — mirrors the adapter's extractArg just
 * enough for the recognizer's needs (object literals + property
 * access + identifiers + booleans + strings).
 */
function extractArgsForTest(call: CallExpression): EffectArg[] {
  return call.getArguments().map((arg) => extractArgForTest(arg));
}

function extractArgForTest(node: Node): EffectArg {
  if (Node.isStringLiteral(node)) {
    return { kind: "string", value: node.getLiteralValue() };
  }
  if (Node.isNumericLiteral(node)) {
    return { kind: "number", value: node.getLiteralValue() };
  }
  if (Node.isTrueLiteral(node)) {
    return { kind: "boolean", value: true };
  }
  if (Node.isFalseLiteral(node)) {
    return { kind: "boolean", value: false };
  }
  if (Node.isObjectLiteralExpression(node)) {
    const fields: Record<string, EffectArg> = {};
    for (const prop of node.getProperties()) {
      if (Node.isShorthandPropertyAssignment(prop)) {
        const name = prop.getName();
        fields[name] = { kind: "identifier", name };
        continue;
      }
      if (!Node.isPropertyAssignment(prop)) {
        continue;
      }
      const initializer = prop.getInitializer();
      if (initializer === undefined) {
        continue;
      }
      fields[prop.getName()] = extractArgForTest(initializer);
    }
    return { kind: "object", fields };
  }
  if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) {
    return { kind: "identifier", name: node.getText() };
  }
  if (Node.isCallExpression(node)) {
    return {
      kind: "call",
      callee: node.getExpression().getText(),
      args: node.getArguments().map((a) => extractArgForTest(a)),
    };
  }
  return null;
}

function storageEffectsOf(effects: Effect[]): Array<
  Extract<Effect, { type: "interaction" }> & {
    interaction: { class: "storage-access" };
  }
> {
  const out: Array<
    Extract<Effect, { type: "interaction" }> & {
      interaction: { class: "storage-access" };
    }
  > = [];
  for (const e of effects) {
    if (e.type === "interaction" && e.interaction.class === "storage-access") {
      out.push(
        e as Extract<Effect, { type: "interaction" }> & {
          interaction: { class: "storage-access" };
        },
      );
    }
  }
  return out;
}

describe("prisma recognizer — happy path", () => {
  it("recognizes findUnique with explicit select", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function getUser(id: number) {
        return await db.user.findUnique({
          where: { id },
          select: { id: true, email: true, name: true },
        });
      }
    `);
    const accesses = storageEffectsOf(recognizeAll(file));
    expect(accesses).toHaveLength(1);
    const access = accesses[0] ?? raise("no access");
    expect(access.interaction).toMatchObject({
      class: "storage-access",
      kind: "read",
      operation: "findUnique",
      selector: ["id"],
    });
    expect(new Set(access.interaction.fields)).toEqual(
      new Set(["id", "email", "name"]),
    );
    expect(access.binding.semantics).toMatchObject({
      name: "storage-relational",
      storageSystem: "postgres",
      scope: "default",
      table: "User",
    });
  });

  it("capitalizes the first letter of the model name to match the schema", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function getPost() {
        return await db.post.findMany({});
      }
    `);
    const access =
      storageEffectsOf(recognizeAll(file))[0] ?? raise("no access");
    expect(access.binding.semantics).toMatchObject({ table: "Post" });
  });

  it("records default-shape (fields=['*']) when no select/include given", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function getUserByEmail(email: string) {
        return await db.user.findUnique({ where: { email } });
      }
    `);
    const access =
      storageEffectsOf(recognizeAll(file))[0] ?? raise("no access");
    expect(access.interaction).toMatchObject({
      kind: "read",
      fields: ["*"],
      selector: ["email"],
    });
  });

  it("records default-shape when the call takes no arguments (count)", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function countUsers() {
        return await db.user.count();
      }
    `);
    const access =
      storageEffectsOf(recognizeAll(file))[0] ?? raise("no access");
    expect(access.interaction).toMatchObject({
      kind: "read",
      fields: ["*"],
      operation: "count",
    });
    expect(access.interaction.selector).toBeUndefined();
  });

  it("recognizes create with data fields", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function createUser(email: string, name: string) {
        return await db.user.create({ data: { email, name } });
      }
    `);
    const access =
      storageEffectsOf(recognizeAll(file))[0] ?? raise("no access");
    expect(access.interaction).toMatchObject({
      kind: "write",
      operation: "create",
    });
    expect(new Set(access.interaction.fields)).toEqual(
      new Set(["email", "name"]),
    );
  });

  it("merges create + update fields for upsert", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function upsertUser(id: number, email: string, name: string) {
        return await db.user.upsert({
          where: { id },
          create: { email, name },
          update: { name },
        });
      }
    `);
    const access =
      storageEffectsOf(recognizeAll(file))[0] ?? raise("no access");
    expect(access.interaction.kind).toBe("write");
    expect(new Set(access.interaction.fields)).toEqual(
      new Set(["email", "name"]),
    );
    expect(access.interaction.selector).toEqual(["id"]);
  });

  it("handles deep receiver chains (ctx.prisma.user.findMany)", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const ctx = { prisma: new PrismaClient() };
      async function go() {
        return await ctx.prisma.user.findMany({});
      }
    `);
    const access =
      storageEffectsOf(recognizeAll(file))[0] ?? raise("no access");
    expect(access.binding.semantics).toMatchObject({ table: "User" });
    expect(access.interaction.operation).toBe("findMany");
  });

  it("threads scope and storageSystem options into emitted effects", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function go() {
        return await db.user.findMany({});
      }
    `);
    const pack = prismaFramework({ scope: "tenants", storageSystem: "mysql" });
    const recognizer =
      pack.invocationRecognizers?.[0] ?? raise("no recognizer");
    const effects: Effect[] = [];
    file.forEachDescendant((node) => {
      if (Node.isCallExpression(node)) {
        const emitted = recognizer(node, {
          call: node,
          sourceFile: file,
          extractArgs: () => extractArgsForTest(node),
        });
        if (emitted !== null) {
          effects.push(...emitted);
        }
      }
    });
    const access = storageEffectsOf(effects)[0] ?? raise("no access");
    expect(access.binding.semantics).toMatchObject({
      storageSystem: "mysql",
      scope: "tenants",
    });
  });
});

describe("prisma recognizer — rejection cases", () => {
  it("ignores calls on non-PrismaClient receivers", () => {
    const file = makeProject(`
      // Locally-defined type that LOOKS like Prisma but isn't from @prisma/client
      class FakeClient {
        user = {
          findMany: async (_args: unknown) => ({}),
        };
      }
      const db = new FakeClient();
      async function go() {
        return await db.user.findMany({});
      }
    `);
    expect(storageEffectsOf(recognizeAll(file))).toEqual([]);
  });

  it("ignores Prisma calls whose method isn't a known operation", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function go() {
        // .then exists on every Promise but isn't a Prisma op
        return await db.user.findMany({}).then((rs) => rs);
      }
    `);
    // Only the findMany should match; .then doesn't.
    const accesses = storageEffectsOf(recognizeAll(file));
    expect(accesses).toHaveLength(1);
    expect(accesses[0]?.interaction.operation).toBe("findMany");
  });

  it("ignores chains shorter than 3 segments (no delegate)", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function go() {
        // Hypothetical short chain — doesn't match the shape
        return await (db as unknown as { findMany: () => Promise<unknown> }).findMany();
      }
    `);
    expect(storageEffectsOf(recognizeAll(file))).toEqual([]);
  });
});

describe("prisma pack metadata", () => {
  it("declares correct pack identity (no discovery, no terminals, recognizer present)", () => {
    const pack = prismaFramework();
    expect(pack.name).toBe("prisma");
    expect(pack.protocol).toBe("in-process");
    expect(pack.discovery).toEqual([]);
    expect(pack.terminals).toEqual([]);
    expect(pack.invocationRecognizers).toHaveLength(1);
  });
});
