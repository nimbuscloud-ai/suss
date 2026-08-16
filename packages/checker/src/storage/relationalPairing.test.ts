import { describe, expect, it } from "vitest";

import { storageRelationalBinding } from "@suss/behavioral-ir";

import { checkRelationalStorage } from "./relationalPairing.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Effect,
  Transition,
} from "@suss/behavioral-ir";

function makeProvider(opts: {
  table: string | null;
  storageSystem?: "postgres" | "mysql" | "sqlite";
  scope?: string;
  columns: Array<{ name: string; type?: string; nullable?: boolean }>;
  physicalTable?: string;
}): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: "schema.prisma",
      range: { start: 1, end: 10 },
      exportName: null,
    },
    identity: {
      name: opts.table ?? "<unnamed>",
      exportPath: null,
      boundaryBinding: storageRelationalBinding({
        recognition: "prisma",
        storageSystem: opts.storageSystem ?? "postgres",
        scope: opts.scope ?? "default",
        table: opts.table,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      storageContract: {
        columns: opts.columns,
        ...(opts.physicalTable !== undefined
          ? { physicalTable: opts.physicalTable }
          : {}),
      },
    },
  };
}

function makeAccessSummary(opts: {
  name: string;
  file: string;
  accesses: Array<{
    table: string | null;
    storageSystem?: "postgres" | "mysql" | "sqlite";
    scope?: string;
    kind: "read" | "write";
    fields: string[];
    selector?: string[];
    operation?: string;
  }>;
}): BehavioralSummary {
  const transition: Transition = {
    id: "t0",
    conditions: [],
    output: { type: "return", value: null },
    effects: opts.accesses.map(
      (a): Effect => ({
        type: "interaction",
        binding: storageRelationalBinding({
          recognition: "test",
          storageSystem: a.storageSystem ?? "postgres",
          scope: a.scope ?? "default",
          table: a.table,
        }) satisfies BoundaryBinding,
        interaction: {
          class: "storage-access",
          kind: a.kind,
          fields: a.fields,
          ...(a.selector !== undefined ? { selector: a.selector } : {}),
          ...(a.operation !== undefined ? { operation: a.operation } : {}),
        },
      }),
    ),
    location: { start: 5, end: 10 },
    isDefault: true,
  };
  return {
    kind: "handler",
    location: {
      file: opts.file,
      range: { start: 1, end: 20 },
      exportName: opts.name,
    },
    identity: {
      name: opts.name,
      exportPath: [opts.name],
      boundaryBinding: null,
    },
    inputs: [],
    transitions: [transition],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

describe("checkRelationalStorage", () => {
  it("pairs nothing when the access states no table", () => {
    // A drizzle query whose table declaration the reader could not
    // settle. Pairing it by source text would check it against a
    // schema table that merely spells the same way.
    const provider = makeProvider({
      table: "users",
      columns: [{ name: "id" }, { name: "email" }],
    });
    const consumer = makeAccessSummary({
      name: "readMystery",
      file: "src/handler.ts",
      accesses: [{ table: null, kind: "read", fields: ["nonsense"] }],
    });
    const findings = checkRelationalStorage([provider, consumer]);
    expect(findings.filter((f) => f.kind === "boundaryFieldUnknown")).toEqual(
      [],
    );
  });

  it("claims no access when the provider states no table", () => {
    const provider = makeProvider({
      table: null,
      columns: [{ name: "id" }],
    });
    const consumer = makeAccessSummary({
      name: "readUsers",
      file: "src/handler.ts",
      accesses: [{ table: "users", kind: "read", fields: ["nonsense"] }],
    });
    expect(checkRelationalStorage([provider, consumer])).toEqual([]);
  });

  it("emits storageReadFieldUnknown when code reads an undeclared column", () => {
    const findings = checkRelationalStorage([
      makeProvider({
        table: "User",
        columns: [{ name: "id" }, { name: "email" }],
      }),
      makeAccessSummary({
        name: "getUser",
        file: "src/getUser.ts",
        accesses: [
          { table: "User", kind: "read", fields: ["email", "deltedAt"] },
        ],
      }),
    ]);
    const unknown = findings.filter(
      (f) => f.kind === "boundaryFieldUnknown" && f.aspect === "read",
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0].severity).toBe("error");
    expect(unknown[0].description).toContain("deltedAt");
    expect(unknown[0].description).toContain("User");
  });

  it("emits storageWriteFieldUnknown when code writes an undeclared column", () => {
    const findings = checkRelationalStorage([
      makeProvider({
        table: "User",
        columns: [{ name: "id" }, { name: "email" }],
      }),
      makeAccessSummary({
        name: "createUser",
        file: "src/createUser.ts",
        accesses: [{ table: "User", kind: "write", fields: ["email", "role"] }],
      }),
    ]);
    const unknown = findings.filter(
      (f) => f.kind === "boundaryFieldUnknown" && f.aspect === "write",
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0].description).toContain("role");
  });

  it("emits storageFieldUnused for columns no caller touches", () => {
    const findings = checkRelationalStorage([
      makeProvider({
        table: "User",
        columns: [{ name: "id" }, { name: "email" }, { name: "deletedAt" }],
      }),
      makeAccessSummary({
        name: "h",
        file: "src/h.ts",
        accesses: [{ table: "User", kind: "read", fields: ["id", "email"] }],
      }),
    ]);
    const unused = findings.filter(
      (f) => f.kind === "boundaryFieldUnused" && f.aspect === undefined,
    );
    expect(unused).toHaveLength(1);
    expect(unused[0].description).toContain("deletedAt");
    expect(unused[0].severity).toBe("warning");
  });

  it("emits storageWriteOnlyField when a column is written but never read", () => {
    const findings = checkRelationalStorage([
      makeProvider({
        table: "User",
        columns: [{ name: "id" }, { name: "lastLoginAt" }],
      }),
      makeAccessSummary({
        name: "recordLogin",
        file: "src/recordLogin.ts",
        accesses: [{ table: "User", kind: "write", fields: ["lastLoginAt"] }],
      }),
      makeAccessSummary({
        name: "getUser",
        file: "src/getUser.ts",
        accesses: [{ table: "User", kind: "read", fields: ["id"] }],
      }),
    ]);
    const writeOnly = findings.filter(
      (f) => f.kind === "boundaryFieldUnused" && f.aspect === "read",
    );
    expect(writeOnly).toHaveLength(1);
    expect(writeOnly[0].description).toContain("lastLoginAt");
  });

  it("suppresses unused-column checks when ANY caller uses default-shape reads", () => {
    const findings = checkRelationalStorage([
      makeProvider({
        table: "User",
        columns: [{ name: "id" }, { name: "email" }, { name: "deletedAt" }],
      }),
      makeAccessSummary({
        name: "getUserAll",
        file: "src/getUserAll.ts",
        // findUnique({ where: { id } }): no select → reads ALL fields
        accesses: [{ table: "User", kind: "read", fields: ["*"] }],
      }),
    ]);
    expect(
      findings.filter(
        (f) => f.kind === "boundaryFieldUnused" && f.aspect === undefined,
      ),
    ).toEqual([]);
  });

  it("default-shape reads do NOT fire field-unknown findings", () => {
    const findings = checkRelationalStorage([
      makeProvider({ table: "User", columns: [{ name: "id" }] }),
      makeAccessSummary({
        name: "h",
        file: "src/h.ts",
        accesses: [{ table: "User", kind: "read", fields: ["*"] }],
      }),
    ]);
    expect(
      findings.filter(
        (f) => f.kind === "boundaryFieldUnknown" && f.aspect === "read",
      ),
    ).toEqual([]);
  });

  it("pairs SQL-name accesses against a model with a physicalTable alias", () => {
    // A Prisma model `User` mapped to the SQL table "users"
    // (@@map). A Drizzle-style consumer speaks the SQL name. The
    // alias makes them the same boundary: the undeclared-column
    // read fires, and `email` counts as read (not unused).
    const findings = checkRelationalStorage([
      makeProvider({
        table: "User",
        physicalTable: "users",
        columns: [{ name: "id" }, { name: "email" }],
      }),
      makeAccessSummary({
        name: "listUsers",
        file: "src/list.ts",
        accesses: [
          { table: "users", kind: "read", fields: ["email", "nonExistent"] },
          { table: "User", kind: "read", fields: ["id"] },
        ],
      }),
    ]);
    const unknownReads = findings.filter(
      (f) => f.kind === "boundaryFieldUnknown" && f.aspect === "read",
    );
    expect(unknownReads).toHaveLength(1);
    expect(unknownReads[0].description).toContain("nonExistent");
    // Both channels' reads count toward usage. Nothing is unused.
    expect(findings.filter((f) => f.kind === "boundaryFieldUnused")).toEqual(
      [],
    );
  });

  it("scopes accesses by (storageSystem, scope, table)", () => {
    const findings = checkRelationalStorage([
      makeProvider({ table: "User", scope: "auth", columns: [{ name: "id" }] }),
      // Same table name, different scope, should NOT pair as a
      // read-field-unknown finding even though "nonExistent" isn't
      // declared on the auth-scope provider.
      makeAccessSummary({
        name: "h",
        file: "src/h.ts",
        accesses: [
          {
            table: "User",
            scope: "billing",
            kind: "read",
            fields: ["nonExistent"],
          },
        ],
      }),
    ]);
    // The auth-scope provider's "id" column WILL show up as
    // storageFieldUnused (no in-scope reader), which is the right
    // behaviour. Just assert the cross-scope read didn't produce a
    // field-unknown finding.
    expect(
      findings.filter(
        (f) => f.kind === "boundaryFieldUnknown" && f.aspect === "read",
      ),
    ).toEqual([]);
  });

  it("multi-table accesses (joins) emit per-table findings", () => {
    const findings = checkRelationalStorage([
      makeProvider({ table: "User", columns: [{ name: "email" }] }),
      makeProvider({ table: "Order", columns: [{ name: "id" }] }),
      makeAccessSummary({
        name: "h",
        file: "src/h.ts",
        accesses: [
          { table: "User", kind: "read", fields: ["email", "deltedAt"] },
          { table: "Order", kind: "read", fields: ["id", "total"] },
        ],
      }),
    ]);
    const unknown = findings.filter(
      (f) => f.kind === "boundaryFieldUnknown" && f.aspect === "read",
    );
    expect(unknown).toHaveLength(2);
    const descriptions = unknown.map((f) => f.description).join("\n");
    expect(descriptions).toContain("deltedAt");
    expect(descriptions).toContain("total");
  });

  it("emits no findings when reads + writes match the schema exactly", () => {
    const findings = checkRelationalStorage([
      makeProvider({
        table: "User",
        columns: [{ name: "id" }, { name: "email" }],
      }),
      makeAccessSummary({
        name: "create",
        file: "src/create.ts",
        accesses: [{ table: "User", kind: "write", fields: ["id", "email"] }],
      }),
      makeAccessSummary({
        name: "read",
        file: "src/read.ts",
        accesses: [{ table: "User", kind: "read", fields: ["id", "email"] }],
      }),
    ]);
    expect(findings).toEqual([]);
  });
});
