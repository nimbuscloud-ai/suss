import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readStorageContractMetadata } from "@suss/behavioral-ir";

import {
  prismaSchemaFiles,
  prismaSchemaFileToSummaries,
  prismaSchemaToSummaries,
  prismaStorageSystem,
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

  it("treats enum-typed fields as columns of one enum type", () => {
    const summaries = prismaSchemaToSummaries(postgresSchema);
    const user =
      summaries.find((s) => s.identity.name === "User") ??
      raise("User summary not found");
    const role = fieldsOf(user).find((c) => c.name === "role");
    expect(role).toBeDefined();
    expect(role?.type).toBe("enum");
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

describe("a schema split over several files", () => {
  const MAIN = `datasource db {\n  provider = "mysql"\n}\n\nmodel User {\n  id    String @id\n  links Link[]\n}\n`;
  const LINK =
    "model Link {\n  id     String @id\n  userId String\n  user   User   @relation(fields: [userId], references: [id])\n}\n";

  function folderWith(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-prisma-split-"));
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), text);
    }
    return dir;
  }

  it("reads the files beside the one with the datasource as one schema", () => {
    const dir = folderWith({ "schema.prisma": MAIN, "link.prisma": LINK });

    expect(prismaSchemaFiles(path.join(dir, "schema.prisma"))).toEqual([
      path.join(dir, "link.prisma"),
      path.join(dir, "schema.prisma"),
    ]);
  });

  it("reads every file below a schema folder", () => {
    const dir = folderWith({
      "schema.prisma": MAIN,
      "models/link.prisma": LINK,
    });

    expect(prismaSchemaFiles(dir)).toEqual([
      path.join(dir, "models/link.prisma"),
      path.join(dir, "schema.prisma"),
    ]);
  });

  it("leaves out a file beside it that does not parse", () => {
    const dir = folderWith({
      "schema.prisma": MAIN,
      "link.prisma": LINK,
      "draft.prisma": "model {",
    });

    expect(prismaSchemaFiles(path.join(dir, "schema.prisma"))).toEqual([
      path.join(dir, "link.prisma"),
      path.join(dir, "schema.prisma"),
    ]);
  });

  it("gives no files for a path that is not there", () => {
    expect(prismaSchemaFiles("/no/such/schema.prisma")).toEqual([]);
  });

  it("reads one file alone when another beside it has its own datasource", () => {
    const dir = folderWith({ "schema.prisma": MAIN, "test.prisma": MAIN });

    expect(prismaSchemaFiles(path.join(dir, "schema.prisma"))).toEqual([
      path.join(dir, "schema.prisma"),
    ]);
  });

  it("gives every model the datasource's database and the file it is in", () => {
    const dir = folderWith({ "schema.prisma": MAIN, "link.prisma": LINK });

    const summaries = prismaSchemaFileToSummaries(
      path.join(dir, "schema.prisma"),
    );

    expect(
      summaries.map((summary) => [
        tableOf(summary),
        storageSystemOf(summary),
        path.basename(summary.location.file),
      ]),
    ).toEqual([
      ["Link", "mysql", "link.prisma"],
      ["User", "mysql", "schema.prisma"],
    ]);
    const link = summaries[0] ?? raise("no Link summary");
    const fields = readStorageContractMetadata(link)?.fields ?? [];
    expect(fields.find((field) => field.name === "user")).toMatchObject({
      relationKey: ["userId"],
    });
  });
});

const DATASOURCE = `datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n`;

function columnsOf(
  summaries: BehavioralSummary[],
  model: string,
): Map<string, Record<string, unknown>> {
  const summary =
    summaries.find((s) => s.identity.name === model) ??
    raise(`${model} summary not found`);
  return new Map(
    (readStorageContractMetadata(summary)?.fields ?? []).map((field) => [
      field.name,
      field as Record<string, unknown>,
    ]),
  );
}

function columnOf(
  summaries: BehavioralSummary[],
  model: string,
  field: string,
): Record<string, unknown> {
  return (
    columnsOf(summaries, model).get(field) ??
    raise(`${model}.${field} not found`)
  );
}

describe("the columns two declarations of one table are compared on", () => {
  it("keeps the field name and records the column a field's @map gives", () => {
    const summaries = prismaSchemaToSummaries(`${DATASOURCE}
model Order {
  id        Int      @id
  createdAt DateTime @map("created_at")
  blobId    String   @map(name: "blob_id")
  total     Int      @map("total")
}
`);
    expect(columnOf(summaries, "Order", "createdAt")).toMatchObject({
      name: "createdAt",
      column: "created_at",
    });
    expect(columnOf(summaries, "Order", "blobId").column).toBe("blob_id");
    // A @map that repeats the field name changes nothing.
    expect(columnOf(summaries, "Order", "total").column).toBeUndefined();
    expect(columnOf(summaries, "Order", "id").column).toBeUndefined();
  });

  it("reads @@map spelled with a name argument", () => {
    const summaries = prismaSchemaToSummaries(`${DATASOURCE}
model Order {
  id Int @id

  @@map(name: "orders")
}
`);
    const order = summaries[0] ?? raise("no Order summary");
    expect(readStorageContractMetadata(order)?.physicalTable).toBe("orders");
  });

  it("says which defaults the database fills and which the client sends", () => {
    const summaries = prismaSchemaToSummaries(`${DATASOURCE}
model Order {
  id         Int      @id @default(autoincrement())
  publicId   String   @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  token      String   @default(uuid())
  slug       String   @default(cuid())
  short      String   @default(nanoid(8))
  sortKey    String   @default(ulid())
  updatedAt  DateTime @updatedAt
  reference  String
  note       String?
}
`);
    const columns = columnsOf(summaries, "Order");
    const defaults = Object.fromEntries(
      [...columns].map(([name, field]) => [name, field.default]),
    );
    expect(defaults).toEqual({
      id: true,
      publicId: true,
      token: false,
      slug: false,
      short: false,
      sortKey: false,
      updatedAt: false,
      reference: false,
      note: false,
    });
  });

  it("leaves a literal or now() default unstated unless Prisma's migrations made the table", () => {
    const schema = `${DATASOURCE}
enum Status {
  PENDING
  PAID
}

model Order {
  id        Int      @id
  status    Status   @default(PENDING)
  paid      Boolean  @default(false)
  label     String   @default("x", map: "order_label_default")
  createdAt DateTime @default(now())
  touchedAt DateTime @default(now()) @updatedAt
}
`;
    const copy = columnsOf(prismaSchemaToSummaries(schema), "Order");
    const migrated = columnsOf(
      prismaSchemaToSummaries(schema, { origin: "migrations" }),
      "Order",
    );
    for (const name of ["status", "paid", "label", "createdAt", "touchedAt"]) {
      expect(copy.get(name)?.default).toBeUndefined();
      expect(migrated.get(name)?.default).toBe(true);
    }
  });

  it("marks every column @@id lists as primary, in either spelling", () => {
    const summaries = prismaSchemaToSummaries(`${DATASOURCE}
model Membership {
  teamId Int
  userId Int
  role   String

  @@id([teamId, userId])
}

model Grant {
  scope   String
  ownerId Int

  @@id(fields: [scope, ownerId], map: "grant_pk")
}
`);
    const membership = columnsOf(summaries, "Membership");
    expect(membership.get("teamId")?.primary).toBe(true);
    expect(membership.get("userId")?.primary).toBe(true);
    expect(membership.get("role")?.primary).toBeUndefined();
    const grant = columnsOf(summaries, "Grant");
    expect(grant.get("scope")?.primary).toBe(true);
    expect(grant.get("ownerId")?.primary).toBe(true);
    const grantSummary =
      summaries.find((s) => s.identity.name === "Grant") ?? raise("no Grant");
    expect(readStorageContractMetadata(grantSummary)?.indexes).toEqual([
      { fields: ["scope", "ownerId"], unique: true },
    ]);
  });

  it("keeps a native type without its arguments", () => {
    const summaries = prismaSchemaToSummaries(`${DATASOURCE}
model Attachment {
  id        String   @id @db.Uuid
  name      String   @db.VarChar(255)
  size      Int      @db.SmallInt
  createdAt DateTime @db.Timestamptz(6)
  plain     String
}
`);
    const types = Object.fromEntries(
      [...columnsOf(summaries, "Attachment")].map(([name, field]) => [
        name,
        field.type,
      ]),
    );
    expect(types).toEqual({
      id: "@db.Uuid",
      name: "@db.VarChar",
      size: "@db.SmallInt",
      createdAt: "@db.Timestamptz",
      plain: "String",
    });
  });

  it("declares a scalar list as a column of a list type", () => {
    const schema = `${DATASOURCE}
enum Role {
  USER
  ADMIN
}

model User {
  id     Int      @id
  tags   String[]
  roles  Role[]
  labels String[] @db.VarChar(20)
  scores Int[]    @default([])
  posts  Post[]
}

model Post {
  id       Int  @id
  authorId Int
  author   User @relation(fields: [authorId], references: [id])
}
`;
    const copy = columnsOf(prismaSchemaToSummaries(schema), "User");
    expect(copy.get("tags")).toMatchObject({
      type: "String[]",
      default: false,
    });
    expect(copy.get("roles")?.type).toBe("enum[]");
    expect(copy.get("labels")?.type).toBe("@db.VarChar[]");
    // A relation list is still a relation, not a column.
    expect(copy.get("posts")).toMatchObject({ type: "Post[]", derived: true });
    // Prisma's migrations make a list column nullable and the client reads
    // NULL there as an empty list, so only a migrated table says which.
    expect(copy.get("tags")?.nullable).toBeUndefined();
    const migrated = columnsOf(
      prismaSchemaToSummaries(schema, { origin: "migrations" }),
      "User",
    );
    expect(migrated.get("tags")?.nullable).toBe(true);
    expect(migrated.get("scores")?.default).toBe(true);
  });

  it("points a foreign key at the table of the model its relation reaches", () => {
    const summaries = prismaSchemaToSummaries(`${DATASOURCE}
model User {
  id    Int    @id
  posts Post[]

  @@map("users")
}

model Team {
  id       Int @id
  tenantId Int
  posts    Post[]
}

model Post {
  id       Int  @id
  authorId Int  @map("author_id")
  author   User @relation(fields: [authorId], references: [id])
  teamId   Int
  tenantId Int
  team     Team @relation(fields: [teamId, tenantId], references: [id, tenantId])
  title    String
}
`);
    const post = columnsOf(summaries, "Post");
    expect(post.get("authorId")).toMatchObject({
      column: "author_id",
      foreignKey: "users",
    });
    expect(post.get("teamId")?.foreignKey).toBe("Team");
    expect(post.get("tenantId")?.foreignKey).toBe("Team");
    expect(post.get("title")?.foreignKey).toBeUndefined();
    // The relation field itself is not a column and has no key of its own.
    expect(post.get("author")?.foreignKey).toBeUndefined();
  });

  it("gives the columns of an implicit join table no default and a key to each model", () => {
    const summaries = prismaSchemaToSummaries(`${DATASOURCE}
model Post {
  id   Int   @id
  tags Tag[]

  @@map("posts")
}

model Tag {
  id    Int    @id
  posts Post[]
}
`);
    const join = columnsOf(summaries, "_PostToTag");
    expect(join.get("A")).toMatchObject({
      default: false,
      foreignKey: "posts",
    });
    expect(join.get("B")).toMatchObject({ default: false, foreignKey: "Tag" });
  });
});

describe("where a schema's columns come from", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function schemaFolder(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-prisma-origin-"));
    made.push(dir);
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), text);
    }
    return dir;
  }

  const SCHEMA = `${DATASOURCE}\nmodel Order {\n  id Int @id\n}\n`;
  const LOCK = 'provider = "postgresql"\n';

  function originOf(summaries: BehavioralSummary[]): string | undefined {
    const first = summaries[0] ?? raise("no summary");
    return readStorageContractMetadata(first)?.origin;
  }

  it("is Prisma's migrations when a migrations folder is next to the schema", () => {
    const dir = schemaFolder({
      "prisma/schema.prisma": SCHEMA,
      "prisma/migrations/migration_lock.toml": LOCK,
    });
    expect(
      originOf(
        prismaSchemaFileToSummaries(path.join(dir, "prisma/schema.prisma")),
      ),
    ).toBe("migrations");
  });

  it("finds the migrations folder beside a schema folder", () => {
    const dir = schemaFolder({
      "prisma/schema/schema.prisma": SCHEMA,
      "prisma/schema/user.prisma": "model User {\n  id Int @id\n}\n",
      "prisma/migrations/migration_lock.toml": LOCK,
    });
    expect(
      originOf(prismaSchemaFileToSummaries(path.join(dir, "prisma/schema"))),
    ).toBe("migrations");
  });

  it("is unstated without a migration lock file", () => {
    const dir = schemaFolder({
      "prisma/schema.prisma": SCHEMA,
      "prisma/migrations/README.md": "hand-written SQL\n",
    });
    expect(
      originOf(
        prismaSchemaFileToSummaries(path.join(dir, "prisma/schema.prisma")),
      ),
    ).toBeUndefined();
  });

  it("does not look above a single schema file", () => {
    const dir = schemaFolder({
      "packages/db/schema.prisma": SCHEMA,
      "packages/migrations/migration_lock.toml": LOCK,
    });
    expect(
      originOf(
        prismaSchemaFileToSummaries(
          path.join(dir, "packages/db/schema.prisma"),
        ),
      ),
    ).toBeUndefined();
  });
});

describe("prismaStorageSystem", () => {
  it("reads the datasource provider, with postgres spelled either way", () => {
    expect(
      prismaStorageSystem(`datasource db {\n  provider = "postgres"\n}`),
    ).toBe("postgresql");
    expect(
      prismaStorageSystem(`datasource db {\n  provider = "sqlite"\n}`),
    ).toBe("sqlite");
  });

  it("gives null for a document store, no datasource, or text that does not parse", () => {
    expect(
      prismaStorageSystem(`datasource db {\n  provider = "mongodb"\n}`),
    ).toBeNull();
    expect(prismaStorageSystem("model Account {\n  id Int @id\n}")).toBeNull();
    expect(prismaStorageSystem("datasource {")).toBeNull();
  });
});
