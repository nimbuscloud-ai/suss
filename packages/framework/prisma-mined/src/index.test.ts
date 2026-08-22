import { type CallExpression, Node, type SourceFile } from "ts-morph";
import { describe, expect, it } from "vitest";

import { ResolutionStore } from "@suss/adapter-typescript";
import { createTestProject } from "@suss/test-project";

import { prismaMinedFramework } from "./index.js";

import type { Effect } from "@suss/behavioral-ir";

// A stand-in for what `prisma generate` writes: a namespaced `Delegate`
// interface per model, and a client class exposing one field per model
// typed to it.
const GENERATED_CLIENT = `
  export namespace Prisma {
    export interface ArticleDelegate {
      findUnique(args: any): Promise<any>;
      findFirst(args?: any): Promise<any>;
      findMany(args?: any): Promise<any>;
      create(args: any): Promise<any>;
      update(args: any): Promise<any>;
      upsert(args: any): Promise<any>;
      delete(args: any): Promise<any>;
      count(args?: any): Promise<any>;
      groupBy(args: any): Promise<any>;
    }
    export interface UserDelegate {
      findUnique(args: any): Promise<any>;
      create(args: any): Promise<any>;
      update(args: any): Promise<any>;
    }
    export interface TagDelegate {
      findMany(args?: any): Promise<any>;
    }
    export interface CommentDelegate {
      findFirst(args?: any): Promise<any>;
      create(args: any): Promise<any>;
      delete(args: any): Promise<any>;
    }
  }
  export declare class PrismaClient {
    article: Prisma.ArticleDelegate;
    user: Prisma.UserDelegate;
    tag: Prisma.TagDelegate;
    comment: Prisma.CommentDelegate;
  }
`;

function effectsIn(source: string): Effect[] {
  const project = createTestProject();
  project.createSourceFile(
    "/node_modules/.prisma/client/package.json",
    JSON.stringify({ name: ".prisma/client", types: "index.d.ts" }),
  );
  project.createSourceFile(
    "/node_modules/.prisma/client/index.d.ts",
    GENERATED_CLIENT,
  );
  project.createSourceFile(
    "/node_modules/@prisma/client/package.json",
    JSON.stringify({ name: "@prisma/client", types: "index.d.ts" }),
  );
  project.createSourceFile(
    "/node_modules/@prisma/client/index.d.ts",
    "export * from '.prisma/client';",
  );
  const sourceFile: SourceFile = project.createSourceFile("/repo.ts", source);
  const store = new ResolutionStore();
  const recognizers = prismaMinedFramework().invocationRecognizers ?? [];
  const effects: Effect[] = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const ctx = {
      call: node as CallExpression,
      sourceFile,
      extractArgs: () => [],
      isImportedFrom: () => false,
      resolveWrittenValue: (value: Node) => store.resolveWrittenValue(value),
    };
    for (const recognizer of recognizers) {
      const emitted = recognizer(node, ctx);
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
  const interaction = effect.interaction;
  if (interaction.class !== "storage-access") {
    throw new Error(`expected storage-access, got ${interaction.class}`);
  }
  return { semantics, interaction };
}

const CLIENT = `import { PrismaClient } from '@prisma/client';\ndeclare const prisma: PrismaClient;`;

describe("a Prisma call", () => {
  it("reads the model, fields, and selector of a findMany with select", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function listTags() {
        return prisma.tag.findMany({
          where: { articles: { some: { author: { demo: true } } } },
          select: { name: true },
        });
      }
    `);

    expect(effects).toHaveLength(1);
    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics).toMatchObject({
      storageSystem: "postgresql",
      container: "Tag",
    });
    expect(interaction).toMatchObject({
      class: "storage-access",
      kind: "read",
      operation: "findMany",
      fields: ["name"],
      selector: ["articles"],
    });
  });

  it("reads a write's fields from data, and settles no selector without a where", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function createUser(email: string, username: string) {
        return prisma.user.create({
          data: { username, email, password: "x" },
          select: { id: true, email: true },
        });
      }
    `);

    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics.container).toBe("User");
    expect(interaction).toMatchObject({
      kind: "write",
      operation: "create",
      fields: ["username", "email", "password"],
    });
    expect(interaction.selector).toBeUndefined();
  });

  it("reads a field written through a conditional spread, the shape a partial update builds data with", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function updateUser(email?: string, bio?: string, active?: boolean) {
        return prisma.user.update({
          where: { id: 1 },
          data: {
            ...(email ? { email } : {}),
            ...(active && { active }),
            bio,
          },
        });
      }
    `);

    expect(storageOf(effects[0]).interaction.fields.sort()).toEqual([
      "active",
      "bio",
      "email",
    ]);
  });

  it("reads a unique where's single non-id key as the binding's accessPath", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function bySlug(slug: string) {
        return prisma.article.findUnique({ where: { slug } });
      }
    `);

    expect(storageOf(effects[0]).semantics.accessPath).toBe("slug");
  });

  it("settles no accessPath for a where keyed by id", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function byId(id: number) {
        return prisma.article.findUnique({ where: { id } });
      }
    `);

    expect(storageOf(effects[0]).semantics.accessPath).toBeNull();
  });

  it("walks AND/OR/NOT to collect the fields a where filters on", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function search(authorId: number) {
        return prisma.article.findMany({
          where: { AND: [{ authorId }, { OR: [{ title: "x" }, { NOT: { body: "y" } }] }] },
        });
      }
    `);

    expect(storageOf(effects[0]).interaction.selector?.sort()).toEqual([
      "authorId",
      "body",
      "title",
    ]);
  });

  it("reads include's keys alongside the whole row, and skips _count", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function getArticle(slug: string) {
        return prisma.article.findUnique({
          where: { slug },
          include: {
            tagList: { select: { name: true } },
            author: { include: { followedBy: true } },
            favoritedBy: true,
            _count: { select: { favoritedBy: true } },
          },
        });
      }
    `);

    const primary = storageOf(effects[0]).interaction;
    expect(primary.fields).toEqual([
      "*",
      "tagList",
      "author",
      "favoritedBy",
      "_count",
    ]);

    const relations = effects.slice(1).map((e) => storageOf(e).interaction);
    expect(relations).toContainEqual(
      expect.objectContaining({ relationPath: ["tagList"], fields: ["name"] }),
    );
    expect(relations).toContainEqual(
      expect.objectContaining({
        relationPath: ["author"],
        fields: ["*", "followedBy"],
      }),
    );
    expect(relations).toContainEqual(
      expect.objectContaining({ relationPath: ["favoritedBy"], fields: ["*"] }),
    );
    expect(relations).toContainEqual(
      expect.objectContaining({
        relationPath: ["author", "followedBy"],
        fields: ["*"],
      }),
    );
    // _count is an aggregate, not a relation with fields of its own.
    expect(
      relations.some((r) => (r.relationPath as string[]).includes("_count")),
    ).toBe(false);
  });

  it("does not guess that a bare `true` under a nested select names a relation", () => {
    // `select: { followedBy: true }` reads the same whether followedBy
    // is a scalar or a relation; only `include` settles it.
    const effects = effectsIn(`
      ${CLIENT}
      export async function getArticle(slug: string) {
        return prisma.article.findUnique({
          where: { slug },
          include: { author: { select: { username: true, followedBy: true } } },
        });
      }
    `);

    const relations = effects.slice(1).map((e) => storageOf(e).interaction);
    expect(relations).toContainEqual(
      expect.objectContaining({
        relationPath: ["author"],
        fields: ["username", "followedBy"],
      }),
    );
    expect(
      relations.some((r) =>
        (r.relationPath as string[]).includes("followedBy"),
      ),
    ).toBe(false);
  });

  it("reads connectOrCreate's create side as the fields a relation write states", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function createArticle(tag: string) {
        return prisma.article.create({
          data: {
            title: "x",
            tagList: { connectOrCreate: [{ create: { name: tag }, where: { name: tag } }] },
            author: { connect: { id: 1 } },
          },
        });
      }
    `);

    const relations = effects.slice(1).map((e) => storageOf(e).interaction);
    expect(relations).toContainEqual(
      expect.objectContaining({
        relationPath: ["tagList"],
        fields: ["name"],
      }),
    );
    expect(relations).toContainEqual(
      expect.objectContaining({
        relationPath: ["author"],
        fields: [],
        relationKey: true,
      }),
    );
  });

  it("reads connectOrCreate's create side through a list built with .map, not just a literal array", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function createArticle(tags: string[]) {
        return prisma.article.create({
          data: {
            title: "x",
            tagList: {
              connectOrCreate: tags.map((tag) => ({ create: { name: tag }, where: { name: tag } })),
            },
          },
        });
      }
    `);

    const relation = effects.slice(1).map((e) => storageOf(e).interaction)[0];
    expect(relation).toMatchObject({
      relationPath: ["tagList"],
      fields: ["name"],
    });
  });

  it("marks connect/disconnect as a relation key, never a field of the far row", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function unfollow(username: string, id: number) {
        return prisma.user.update({
          where: { username },
          data: { followedBy: { disconnect: { id } } },
        });
      }
    `);

    const relation = storageOf(effects[1]).interaction;
    expect(relation).toMatchObject({
      relationPath: ["followedBy"],
      relationKey: true,
      fields: [],
    });
  });

  it("follows select through a variable bound earlier, the same as a query built once and reused", () => {
    const effects = effectsIn(`
      ${CLIENT}
      const AUTHOR_SELECT = { username: true, bio: true };
      export async function getArticle(slug: string) {
        return prisma.article.findUnique({ where: { slug }, include: { author: { select: AUTHOR_SELECT } } });
      }
    `);

    const relation = effects
      .slice(1)
      .map((e) => storageOf(e).interaction)
      .find((i) => (i.relationPath as string[])[0] === "author");
    expect(relation?.fields).toEqual(["username", "bio"]);
  });

  it("reads groupBy's `by` as the fields it groups on", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function tagCounts() {
        return prisma.article.groupBy({ by: ["authorId"] });
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "read",
      operation: "groupBy",
      fields: ["authorId"],
    });
  });

  it("reads count as a read with no fields of its own", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function countArticles() {
        return prisma.article.count({ where: { authorId: 1 } });
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "read",
      operation: "count",
      fields: [],
      selector: ["authorId"],
    });
  });

  it("reads delete as a whole-row write", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function deleteComment(id: number) {
        return prisma.comment.delete({ where: { id } });
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "write",
      operation: "delete",
      fields: ["*"],
    });
  });

  it("unions upsert's create and update fields", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function upsertTag(name: string) {
        return prisma.article.upsert({
          where: { id: 1 },
          create: { title: "x", slug: name },
          update: { title: "y" },
        });
      }
    `);

    expect(storageOf(effects[0]).interaction.fields.sort()).toEqual([
      "slug",
      "title",
    ]);
  });

  it("leaves a same-shaped call on a plain object alone", () => {
    expect(
      effectsIn(`
        declare const article: { findMany(args: unknown): Promise<unknown[]> };
        export async function list() {
          return article.findMany({ where: { id: 1 } });
        }
      `),
    ).toEqual([]);
  });
});

describe("the pack itself", () => {
  it("fires only on a file reaching the generated client", () => {
    expect(prismaMinedFramework()).toMatchObject({
      name: "prisma-mined",
      protocol: "in-process",
      requiresImport: [".prisma/client", "@prisma/client"],
    });
  });

  it("takes a storage system through options", () => {
    const pack = prismaMinedFramework({ storageSystem: "mysql" });
    const recognizer = pack.invocationRecognizers?.[0];
    expect(recognizer).toBeDefined();
  });
});
