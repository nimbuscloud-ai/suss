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
  return s?.name === "storage-relational" ? s.table : null;
}

function storageSystemOf(summary: BehavioralSummary): string | null {
  const s = summary.identity.boundaryBinding?.semantics;
  return s?.name === "storage-relational" ? s.storageSystem : null;
}

function scopeOf(summary: BehavioralSummary): string | null {
  const s = summary.identity.boundaryBinding?.semantics;
  return s?.name === "storage-relational" ? s.scope : null;
}

function columnsOf(summary: BehavioralSummary): Array<{
  name: string;
  type: string;
  nullable: boolean;
  primary?: boolean;
  unique?: boolean;
}> {
  const meta = summary.metadata as
    | { storageContract?: { columns: unknown[] } }
    | undefined;
  return (meta?.storageContract?.columns ?? []) as Array<{
    name: string;
    type: string;
    nullable: boolean;
    primary?: boolean;
    unique?: boolean;
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
      expect(storageSystemOf(s)).toBe("postgres");
    }
  });

  it("uses model name as table name", () => {
    const summaries = prismaSchemaToSummaries(postgresSchema);
    const user =
      summaries.find((s) => s.identity.name === "User") ??
      raise("User summary not found");
    expect(tableOf(user)).toBe("User");
  });

  it("captures scalar columns with type, nullable, primary, unique", () => {
    const summaries = prismaSchemaToSummaries(postgresSchema);
    const user =
      summaries.find((s) => s.identity.name === "User") ??
      raise("User summary not found");
    const cols = columnsOf(user);

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
    const role = columnsOf(user).find((c) => c.name === "role");
    expect(role).toBeDefined();
    expect(role?.type).toBe("Role");
  });

  it("skips relation fields and relation-array fields", () => {
    const summaries = prismaSchemaToSummaries(postgresSchema);
    const user =
      summaries.find((s) => s.identity.name === "User") ??
      raise("User summary not found");
    const post =
      summaries.find((s) => s.identity.name === "Post") ??
      raise("Post summary not found");
    expect(columnsOf(user).find((c) => c.name === "posts")).toBeUndefined();
    expect(columnsOf(post).find((c) => c.name === "author")).toBeUndefined();
    // FK columns ARE captured.
    expect(columnsOf(post).find((c) => c.name === "authorId")).toBeDefined();
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
