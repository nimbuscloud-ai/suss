import { type CallExpression, Node, type SourceFile } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

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
  const project = createTestProject();

  // Minimal @prisma/client surface: enough to give the symbol a
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
        $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
        $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
        $queryRawUnsafe(sql: string, ...values: unknown[]): Promise<unknown>;
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
 * A small EffectArg builder, mirroring the adapter's extractArg closely enough
 * for what the recognizer needs: object literals, property access, identifiers,
 * booleans, and strings.
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
  if (Node.isArrayLiteralExpression(node)) {
    return {
      kind: "array",
      items: node.getElements().map((el) => extractArgForTest(el)),
    };
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

describe("prisma recognizer: happy path", () => {
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
      name: "storage",
      storageSystem: "postgresql",
      scope: "default",
      container: "User",
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
    expect(access.binding.semantics).toMatchObject({ container: "Post" });
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

  it("records the whole record when a query includes a relation", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function getArticle(slug: string) {
        return await db.article.findUnique({
          where: { slug },
          include: { author: true, tagList: true },
        });
      }
    `);
    const access =
      storageEffectsOf(recognizeAll(file))[0] ?? raise("no access");
    // Prisma returns every column of the article beside the relations,
    // so the columns are read even though nothing asks for them by name.
    expect(access.interaction).toMatchObject({
      kind: "read",
      fields: ["*"],
      selector: ["slug"],
    });
  });

  it("reads the model a nested select points at, through the relation", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function getComments(slug: string) {
        return await db.article.findUnique({
          where: { slug },
          include: {
            comments: { select: { id: true, body: true } },
          },
        });
      }
    `);
    const accesses = storageEffectsOf(recognizeAll(file));
    expect(accesses).toHaveLength(2);
    expect(accesses[1]?.interaction).toMatchObject({
      kind: "read",
      fields: ["id", "body"],
      relationPath: ["comments"],
      operation: "findUnique",
    });
    // The relation says which field, and the contract says which model,
    // so the binding stays on the model the query addressed.
    expect(accesses[1]?.binding.semantics).toMatchObject({
      container: "Article",
    });
  });

  it("reads a relation asked for through another relation", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function getComments(slug: string) {
        return await db.article.findUnique({
          where: { slug },
          include: {
            comments: {
              select: {
                body: true,
                author: { select: { username: true } },
              },
            },
          },
        });
      }
    `);
    const accesses = storageEffectsOf(recognizeAll(file));
    expect(accesses.map((a) => a.interaction.relationPath)).toEqual([
      undefined,
      ["comments"],
      ["comments", "author"],
    ]);
    expect(accesses[2]?.interaction.fields).toEqual(["username"]);
  });

  it("reads the whole related record when an include asks for no fields", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function getArticle(slug: string) {
        return await db.article.findUnique({
          where: { slug },
          include: { comments: true },
        });
      }
    `);
    const accesses = storageEffectsOf(recognizeAll(file));
    expect(accesses).toHaveLength(2);
    expect(accesses[1]?.interaction).toMatchObject({
      kind: "read",
      fields: ["*"],
      relationPath: ["comments"],
    });
  });

  it("leaves a column asked for by name out of the relations", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function getUser(id: number) {
        return await db.user.findUnique({
          where: { id },
          select: { id: true, email: true },
        });
      }
    `);
    expect(storageEffectsOf(recognizeAll(file))).toHaveLength(1);
  });

  it("reads the relation a write asks for back", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function addComment(body: string) {
        return await db.comment.create({
          data: { body },
          include: { author: { select: { username: true } } },
        });
      }
    `);
    const accesses = storageEffectsOf(recognizeAll(file));
    expect(accesses).toHaveLength(2);
    expect(accesses[0]?.interaction).toMatchObject({
      kind: "write",
      fields: ["body"],
    });
    expect(accesses[1]?.interaction).toMatchObject({
      kind: "read",
      fields: ["username"],
      relationPath: ["author"],
    });
  });

  it("writes the model a nested connectOrCreate inserts into", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function createArticle(title: string) {
        return await db.article.create({
          data: {
            title,
            tagList: {
              connectOrCreate: [{ create: { name: "ts" }, where: { name: "ts" } }],
            },
          },
        });
      }
    `);
    const accesses = storageEffectsOf(recognizeAll(file));
    expect(accesses).toHaveLength(3);
    expect(accesses[1]?.interaction).toMatchObject({
      kind: "write",
      fields: ["name"],
      relationPath: ["tagList"],
      operation: "connectOrCreate",
    });
    expect(accesses[1]?.binding.semantics).toMatchObject({
      container: "Article",
    });
  });

  it("keeps a relation out of the columns the call itself writes", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function addComment(body: string, articleId: number) {
        return await db.comment.create({
          data: { body, article: { connect: { id: articleId } } },
        });
      }
    `);
    const accesses = storageEffectsOf(recognizeAll(file));
    expect(accesses[0]?.interaction).toMatchObject({
      kind: "write",
      fields: ["body"],
      operation: "create",
    });
  });

  it("writes a relation's key, unnamed, for an operation that moves a join", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function favorite(slug: string, id: number) {
        await db.article.update({
          where: { slug },
          data: { favoritedBy: { connect: { id } } },
        });
        await db.article.update({
          where: { slug },
          data: { favoritedBy: { disconnect: { id } } },
        });
        await db.article.update({
          where: { slug },
          data: { tagList: { set: [] } },
        });
      }
    `);
    const moves = storageEffectsOf(recognizeAll(file)).filter(
      (access) => access.interaction.relationPath !== undefined,
    );
    expect(moves.map((access) => access.interaction)).toEqual([
      {
        class: "storage-access",
        kind: "write",
        fields: [],
        relationPath: ["favoritedBy"],
        relationKey: true,
        operation: "connect",
      },
      {
        class: "storage-access",
        kind: "write",
        fields: [],
        relationPath: ["favoritedBy"],
        relationKey: true,
        operation: "disconnect",
      },
      {
        class: "storage-access",
        kind: "write",
        fields: [],
        relationPath: ["tagList"],
        relationKey: true,
        operation: "set",
      },
    ]);
  });

  it("writes both the row a connectOrCreate inserts and the key it sets", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function createArticle(title: string) {
        return await db.article.create({
          data: {
            title,
            tagList: {
              connectOrCreate: [{ create: { name: "ts" }, where: { name: "ts" } }],
            },
          },
        });
      }
    `);
    const accesses = storageEffectsOf(recognizeAll(file));
    expect(accesses[2]?.interaction).toMatchObject({
      kind: "write",
      fields: [],
      relationPath: ["tagList"],
      relationKey: true,
      operation: "connectOrCreate",
    });
  });

  it("writes the whole row when the nested payload is built elsewhere", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function createArticle(title: string, tags: string[]) {
        return await db.article.create({
          data: {
            title,
            tagList: {
              connectOrCreate: tags.map((tag: string) => ({
                create: { name: tag },
                where: { name: tag },
              })),
            },
          },
        });
      }
    `);
    const accesses = storageEffectsOf(recognizeAll(file));
    expect(accesses[1]?.interaction).toMatchObject({
      kind: "write",
      fields: ["*"],
      relationPath: ["tagList"],
    });
  });

  it("leaves a scalar written the long way to the contract as well", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function retitle(id: number) {
        await db.article.update({
          where: { id },
          data: { title: { set: "new" } },
        });
      }
    `);
    const accesses = storageEffectsOf(recognizeAll(file));
    expect(accesses[0]?.interaction.fields).toEqual([]);
    expect(accesses[1]?.interaction).toMatchObject({
      fields: [],
      relationPath: ["title"],
      relationKey: true,
      operation: "set",
    });
  });

  it("keeps a write whose payload nobody could read as the whole row", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function createArticle(payload: any) {
        return await db.article.create({ data: payload });
      }
    `);
    const accesses = storageEffectsOf(recognizeAll(file));
    expect(accesses[0]?.interaction).toMatchObject({
      kind: "write",
      fields: ["*"],
    });
  });

  it("writes a model reached through two nested creates", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function createUser(email: string) {
        return await db.user.create({
          data: {
            email,
            profile: {
              create: {
                bio: "hi",
                avatar: { create: { url: "u" } },
              },
            },
          },
        });
      }
    `);
    const accesses = storageEffectsOf(recognizeAll(file));
    expect(accesses.map((a) => a.interaction.relationPath)).toEqual([
      undefined,
      ["profile"],
      ["profile", "avatar"],
    ]);
    expect(accesses[1]?.interaction.fields).toEqual(["bio", "avatar"]);
    expect(accesses[2]?.interaction.fields).toEqual(["url"]);
  });

  it("takes a nested update's fields from its data, and an upsert's from both", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function editComments(id: number) {
        await db.article.update({
          where: { id },
          data: {
            comments: { update: { where: { id }, data: { body: "b" } } },
          },
        });
        await db.article.update({
          where: { id },
          data: {
            author: { upsert: { create: { email: "e" }, update: { bio: "b" } } },
          },
        });
      }
    `);
    const accesses = storageEffectsOf(recognizeAll(file));
    expect(accesses[1]?.interaction).toMatchObject({
      fields: ["body"],
      relationPath: ["comments"],
      operation: "update",
    });
    expect(accesses[3]?.interaction).toMatchObject({
      fields: ["email", "bio"],
      relationPath: ["author"],
      operation: "upsert",
    });
  });

  it("takes a nested update against a single relation as the row itself", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function editAuthor(id: number) {
        await db.article.update({
          where: { id },
          data: { author: { update: { bio: "b" } } },
        });
      }
    `);
    const accesses = storageEffectsOf(recognizeAll(file));
    expect(accesses[1]?.interaction).toMatchObject({
      fields: ["bio"],
      relationPath: ["author"],
      operation: "update",
    });
  });

  it("writes the whole row for a nested delete", () => {
    const file = makeProject(`
      import { PrismaClient } from "@prisma/client";
      const db = new PrismaClient();
      async function dropComment(id: number, commentId: number) {
        await db.article.update({
          where: { id },
          data: { comments: { delete: { id: commentId } } },
        });
      }
    `);
    const accesses = storageEffectsOf(recognizeAll(file));
    expect(accesses[1]?.interaction).toMatchObject({
      kind: "write",
      fields: ["*"],
      relationPath: ["comments"],
      operation: "delete",
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
    expect(access.binding.semantics).toMatchObject({ container: "User" });
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

describe("prisma recognizer: rejection cases", () => {
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
        // Hypothetical short chain: doesn't match the shape
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

describe("prisma raw SQL", () => {
  function rawEffects(source: string): Effect[] {
    const sourceFile = makeProject(source);
    const recognizers = prismaFramework().accessRecognizers ?? [];
    const effects: Effect[] = [];
    sourceFile.forEachDescendant((node) => {
      for (const recognizer of recognizers) {
        const emitted = recognizer(node, {
          access: node,
          sourceFile,
          resolveWrittenValue: () => null,
        });
        if (emitted !== null) {
          effects.push(...emitted);
        }
      }
    });
    return effects;
  }

  function storageOf(effect: Effect) {
    if (effect.type !== "interaction") {
      throw new Error(`expected an interaction, got ${effect.type}`);
    }
    const semantics = effect.binding.semantics;
    if (semantics.name !== "storage") {
      throw new Error(`expected storage, got ${semantics.name}`);
    }
    return { semantics, interaction: effect.interaction };
  }

  it("reads a query the client takes as a tagged template", () => {
    const effects = rawEffects(`
      import { PrismaClient } from "@prisma/client";
      const prisma = new PrismaClient();
      export async function activeUsers(tenant: string) {
        return prisma.$queryRaw\`SELECT id, email FROM users WHERE tenant_id = \${tenant}\`;
      }
    `);

    expect(effects).toHaveLength(1);
    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics).toMatchObject({ container: "users" });
    expect(interaction).toMatchObject({
      kind: "read",
      fields: ["id", "email"],
      selector: ["tenant_id"],
      operation: "$queryRaw",
    });
  });

  it("reads a write the client takes as a tagged template", () => {
    const effects = rawEffects(`
      import { PrismaClient } from "@prisma/client";
      const prisma = new PrismaClient();
      export async function touch(id: number) {
        return prisma.$executeRaw\`UPDATE users SET last_seen = NOW() WHERE id = \${id}\`;
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "write",
      fields: ["last_seen"],
      selector: ["id"],
    });
  });

  it("reads the unsafe form, which takes the query as a string", () => {
    const effects = rawEffects(`
      import { PrismaClient } from "@prisma/client";
      const prisma = new PrismaClient();
      export async function all() {
        return prisma.$queryRawUnsafe("SELECT id FROM users");
      }
    `);

    expect(storageOf(effects[0]).semantics).toMatchObject({
      container: "users",
    });
  });

  it("leaves a tagged template that is not the client's alone", () => {
    expect(
      rawEffects(`
        import { PrismaClient } from "@prisma/client";
        const prisma = new PrismaClient();
        const other = { $queryRaw: (s: TemplateStringsArray) => s };
        export function get() {
          return other.$queryRaw\`SELECT id FROM users\`;
        }
      `),
    ).toEqual([]);
  });
});
