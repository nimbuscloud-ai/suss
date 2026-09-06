import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  prismaSchemaFileToSummaries,
  prismaSchemaToSummaries,
} from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const raise = (msg: string): never => {
  throw new Error(msg);
};

function tableOf(summary: BehavioralSummary): string | null {
  const s = summary.identity.boundaryBinding?.semantics;
  return s?.name === "storage" ? s.container : null;
}

function storageSystemOf(summary: BehavioralSummary): string | null {
  const s = summary.identity.boundaryBinding?.semantics;
  return s?.name === "storage" ? s.storageSystem : null;
}

function scopeOf(summary: BehavioralSummary): string | null {
  const s = summary.identity.boundaryBinding?.semantics;
  return s?.name === "storage" ? s.scope : null;
}

function fieldsOf(summary: BehavioralSummary): Array<{
  name: string;
  type: string;
  nullable: boolean;
  primary?: boolean;
  unique?: boolean;
  relationKey?: string[];
  joinContainer?: string;
}> {
  const meta = summary.metadata as
    | { storageContract?: { fields: unknown[] } }
    | undefined;
  return (meta?.storageContract?.fields ?? []) as Array<{
    name: string;
    type: string;
    nullable: boolean;
    primary?: boolean;
    unique?: boolean;
    relationKey?: string[];
    joinContainer?: string;
  }>;
}

function indexesOf(
  summary: BehavioralSummary,
): Array<{ fields: string[]; unique: boolean }> {
  const meta = summary.metadata as
    | { storageContract?: { indexes: unknown[] } }
    | undefined;
  return (meta?.storageContract?.indexes ?? []) as Array<{
    fields: string[];
    unique: boolean;
  }>;
}

const postgresSchema = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

enum Role {
  USER
  ADMIN
}

model User {
  id        Int       @id @default(autoincrement())
  email     String    @unique
  name      String?
  role      Role      @default(USER)
  deletedAt DateTime?
  posts     Post[]

  @@index([email])
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  authorId Int
  author   User   @relation(fields: [authorId], references: [id])

  @@unique([authorId, title])
}
`;

describe("prismaSchemaToSummaries", () => {
  it("emits one summary per model", () => {
    const summaries = prismaSchemaToSummaries(postgresSchema);
    expect(summaries.map((s) => s.identity.name).sort()).toEqual([
      "Post",
      "User",
    ]);
  });

  it("infers storage system from datasource provider", () => {
    const summaries = prismaSchemaToSummaries(postgresSchema);
    for (const s of summaries) {
      expect(storageSystemOf(s)).toBe("postgresql");
    }
  });

  it("uses model name as table name", () => {
    const summaries = prismaSchemaToSummaries(postgresSchema);
    const user =
      summaries.find((s) => s.identity.name === "User") ??
      raise("User summary not found");
    expect(tableOf(user)).toBe("User");
  });

  it("reads @@map into storageContract.physicalTable", () => {
    const summaries = prismaSchemaToSummaries(`
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id    Int    @id
  email String

  @@map("users")
}

model Post {
  id Int @id
}
`);
    const user =
      summaries.find((s) => s.identity.name === "User") ??
      raise("User summary not found");
    // The binding channel stays the model name; the SQL name rides
    // along as the cross-tool alias.
    expect(tableOf(user)).toBe("User");
    expect(
      (user.metadata?.storageContract as { physicalTable?: string })
        .physicalTable,
    ).toBe("users");
    // No @@map → no alias key at all.
    const post =
      summaries.find((s) => s.identity.name === "Post") ??
      raise("Post summary not found");
    expect(
      (post.metadata?.storageContract as { physicalTable?: string })
        .physicalTable,
    ).toBeUndefined();
  });

  it("captures scalar columns with type, nullable, primary, unique", () => {
    const summaries = prismaSchemaToSummaries(postgresSchema);
    const user =
      summaries.find((s) => s.identity.name === "User") ??
      raise("User summary not found");
    const cols = fieldsOf(user);

    const id = cols.find((c) => c.name === "id") ?? raise("id col missing");
    expect(id).toMatchObject({ type: "Int", nullable: false, primary: true });

    const email =
      cols.find((c) => c.name === "email") ?? raise("email col missing");
    expect(email).toMatchObject({
      type: "String",
      nullable: false,
      unique: true,
    });

    const name =
      cols.find((c) => c.name === "name") ?? raise("name col missing");
    expect(name).toMatchObject({ type: "String", nullable: true });
    expect(name.primary).toBeUndefined();
    expect(name.unique).toBeUndefined();
  });

  it("treats enum-typed fields as columns", () => {
    const summaries = prismaSchemaToSummaries(postgresSchema);
    const user =
      summaries.find((s) => s.identity.name === "User") ??
      raise("User summary not found");
    const role = fieldsOf(user).find((c) => c.name === "role");
    expect(role).toBeDefined();
    expect(role?.type).toBe("Role");
  });

  it("declares a relation field by the model it points at", () => {
    const summaries = prismaSchemaToSummaries(postgresSchema);
    const user =
      summaries.find((s) => s.identity.name === "User") ??
      raise("User summary not found");
    const post =
      summaries.find((s) => s.identity.name === "Post") ??
      raise("Post summary not found");
    // The client takes either of these in an `include`, so a contract
    // that calls itself exhaustive has to declare them.
    expect(fieldsOf(user).find((c) => c.name === "posts")?.type).toBe("Post[]");
    expect(fieldsOf(post).find((c) => c.name === "author")?.type).toBe("User");
    // FK columns are still captured.
    expect(fieldsOf(post).find((c) => c.name === "authorId")).toBeDefined();
  });

  it("gives the side declaring the foreign key the columns it sets", () => {
    const summaries = prismaSchemaToSummaries(postgresSchema);
    const user =
      summaries.find((s) => s.identity.name === "User") ??
      raise("User summary not found");
    const post =
      summaries.find((s) => s.identity.name === "Post") ??
      raise("Post summary not found");
    expect(
      fieldsOf(post).find((c) => c.name === "author")?.relationKey,
    ).toEqual(["authorId"]);
    expect(
      fieldsOf(user).find((c) => c.name === "posts")?.relationKey,
    ).toBeUndefined();
  });

  it("finds the fields argument whatever order the relation states it in", () => {
    const summaries = prismaSchemaToSummaries(`
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Article {
  id       Int    @id
  author   User   @relation("UserArticles", onDelete: Cascade, references: [id], fields: [authorId])
  authorId Int
}

model User {
  id       Int       @id
  articles Article[] @relation("UserArticles")
}
`);
    const article =
      summaries.find((s) => s.identity.name === "Article") ??
      raise("Article summary not found");
    expect(
      fieldsOf(article).find((c) => c.name === "author")?.relationKey,
    ).toEqual(["authorId"]);
  });

  it("gives a compound foreign key every column it names", () => {
    const summaries = prismaSchemaToSummaries(`
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Membership {
  id      Int  @id
  team    Team @relation(fields: [teamId, tenantId], references: [id, tenantId])
  teamId  Int
  tenantId Int
}

model Team {
  id       Int          @id
  tenantId Int
  members  Membership[]
}
`);
    const membership =
      summaries.find((s) => s.identity.name === "Membership") ??
      raise("Membership summary not found");
    expect(
      fieldsOf(membership).find((c) => c.name === "team")?.relationKey,
    ).toEqual(["teamId", "tenantId"]);
  });

  it("declares _count on a model with a relation", () => {
    const summaries = prismaSchemaToSummaries(postgresSchema);
    const user =
      summaries.find((s) => s.identity.name === "User") ??
      raise("User summary not found");
    // Prisma serves `_count` on a model with relations, and nothing in
    // the schema writes it down.
    expect(fieldsOf(user).find((c) => c.name === "_count")).toBeDefined();
  });

  it("captures @@index and @@unique block attributes", () => {
    const summaries = prismaSchemaToSummaries(postgresSchema);
    const user =
      summaries.find((s) => s.identity.name === "User") ??
      raise("User summary not found");
    const post =
      summaries.find((s) => s.identity.name === "Post") ??
      raise("Post summary not found");
    expect(indexesOf(user)).toContainEqual({
      fields: ["email"],
      unique: false,
    });
    expect(indexesOf(post)).toContainEqual({
      fields: ["authorId", "title"],
      unique: true,
    });
  });

  it("emits library-kind summaries with high declared confidence", () => {
    const summaries = prismaSchemaToSummaries(postgresSchema);
    for (const s of summaries) {
      expect(s.kind).toBe("library");
      expect(s.confidence).toEqual({ source: "declared", level: "high" });
    }
  });

  it("threads scope option into the binding semantics", () => {
    const summaries = prismaSchemaToSummaries(postgresSchema, {
      scope: "tenants-db",
    });
    const first = summaries[0] ?? raise("expected at least one summary");
    expect(scopeOf(first)).toBe("tenants-db");
  });

  it("defaults scope to 'default'", () => {
    const summaries = prismaSchemaToSummaries(postgresSchema);
    const first = summaries[0] ?? raise("expected at least one summary");
    expect(scopeOf(first)).toBe("default");
  });

  it("maps mysql provider to mysql storage system", () => {
    const schema = `
datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}

model A {
  id Int @id
}
`;
    const summaries = prismaSchemaToSummaries(schema);
    const first = summaries[0] ?? raise("expected at least one summary");
    expect(storageSystemOf(first)).toBe("mysql");
  });

  it("maps sqlite provider to sqlite storage system", () => {
    const schema = `
datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

model A {
  id Int @id
}
`;
    const summaries = prismaSchemaToSummaries(schema);
    const first = summaries[0] ?? raise("expected at least one summary");
    expect(storageSystemOf(first)).toBe("sqlite");
  });

  it("emits nothing for non-relational providers (e.g. mongodb)", () => {
    const schema = `
datasource db {
  provider = "mongodb"
  url      = env("DATABASE_URL")
}

model A {
  id String @id @map("_id") @db.ObjectId
  name String
}
`;
    const summaries = prismaSchemaToSummaries(schema);
    expect(summaries).toEqual([]);
  });

  it("emits nothing when no datasource is declared", () => {
    const schema = `
model A {
  id Int @id
}
`;
    expect(prismaSchemaToSummaries(schema)).toEqual([]);
  });
});

describe("implicit many-to-many join tables", () => {
  it("declares a boundary named after the two models, alphabetized", () => {
    const summaries = prismaSchemaToSummaries(`
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Post {
  id      Int   @id
  tagList Tag[]
}

model Tag {
  id    Int    @id
  posts Post[]
}
`);
    const join =
      summaries.find((s) => s.identity.name === "_PostToTag") ??
      raise("join table summary not found");
    expect(tableOf(join)).toBe("_PostToTag");
    expect(storageSystemOf(join)).toBe("postgresql");
    const fields = fieldsOf(join);
    expect(fields.find((f) => f.name === "A")).toMatchObject({
      type: "Post",
      primary: true,
    });
    expect(fields.find((f) => f.name === "B")).toMatchObject({
      type: "Tag",
      primary: true,
    });
  });

  it("names the table after a @relation given on both sides", () => {
    const summaries = prismaSchemaToSummaries(`
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Article {
  id          Int    @id
  favoritedBy User[] @relation("UserFavorites")
}

model User {
  id        Int       @id
  favorites Article[] @relation("UserFavorites")
}
`);
    expect(summaries.map((s) => s.identity.name).sort()).toEqual([
      "Article",
      "User",
      "_UserFavorites",
    ]);
  });

  it("points each list field at the join table it writes through", () => {
    const summaries = prismaSchemaToSummaries(`
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Article {
  id          Int    @id
  favoritedBy User[] @relation("UserFavorites")
}

model User {
  id        Int       @id
  favorites Article[] @relation("UserFavorites")
}
`);
    const article =
      summaries.find((s) => s.identity.name === "Article") ??
      raise("Article summary not found");
    const user =
      summaries.find((s) => s.identity.name === "User") ??
      raise("User summary not found");
    expect(
      fieldsOf(article).find((f) => f.name === "favoritedBy")?.joinContainer,
    ).toBe("_UserFavorites");
    expect(
      fieldsOf(user).find((f) => f.name === "favorites")?.joinContainer,
    ).toBe("_UserFavorites");
  });

  it("leaves an explicit join model as an ordinary model, with no extra summary", () => {
    const summaries = prismaSchemaToSummaries(`
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Article {
  id   Int          @id
  tags ArticleTag[]
}

model Tag {
  id       Int          @id
  articles ArticleTag[]
}

model ArticleTag {
  articleId Int
  tagId     Int
  article   Article @relation(fields: [articleId], references: [id])
  tag       Tag     @relation(fields: [tagId], references: [id])

  @@id([articleId, tagId])
}
`);
    expect(summaries.map((s) => s.identity.name).sort()).toEqual([
      "Article",
      "ArticleTag",
      "Tag",
    ]);
    const article =
      summaries.find((s) => s.identity.name === "Article") ??
      raise("Article summary not found");
    expect(
      fieldsOf(article).find((f) => f.name === "tags")?.joinContainer,
    ).toBeUndefined();
  });

  it("keeps two distinct relations between the same two models apart", () => {
    const summaries = prismaSchemaToSummaries(`
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id         Int    @id
  following  User[] @relation("Follows")
  followers  User[] @relation("Follows")
  blocked    User[] @relation("Blocks")
  blockedBy  User[] @relation("Blocks")
}
`);
    expect(summaries.map((s) => s.identity.name).sort()).toEqual([
      "User",
      "_Blocks",
      "_Follows",
    ]);
  });
});

describe("prismaSchemaFileToSummaries", () => {
  it("reads a schema file from disk", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "suss-prisma-"));
    const file = path.join(tmp, "schema.prisma");
    fs.writeFileSync(file, postgresSchema);
    try {
      const summaries = prismaSchemaFileToSummaries(file);
      expect(summaries).toHaveLength(2);
      // Source path is recorded relative to cwd.
      for (const s of summaries) {
        expect(s.location.file).toMatch(/schema\.prisma$/);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("throws when the schema file is missing", () => {
    expect(() => prismaSchemaFileToSummaries("/no/such/schema.prisma")).toThrow(
      /not found/,
    );
  });

  it("honours an explicit source override", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "suss-prisma-"));
    const file = path.join(tmp, "schema.prisma");
    fs.writeFileSync(file, postgresSchema);
    try {
      const summaries = prismaSchemaFileToSummaries(file, {
        source: "custom/path/schema.prisma",
      });
      for (const s of summaries) {
        expect(s.location.file).toBe("custom/path/schema.prisma");
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
