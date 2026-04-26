import { describe, expect, it } from "vitest";

import { storageRelationalBinding } from "@suss/behavioral-ir";

import { checkRelationalStorage } from "./relationalPairing.js";

import type {
  BehavioralSummary,
  Effect,
  Transition,
} from "@suss/behavioral-ir";

function makeProvider(opts: {
  table: string;
  storageSystem?: "postgres" | "mysql" | "sqlite";
  scope?: string;
  columns: Array<{ name: string; type?: string; nullable?: boolean }>;
}): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: "schema.prisma",
      range: { start: 1, end: 10 },
      exportName: null,
    },
    identity: {
      name: opts.table,
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
      storageContract: { columns: opts.columns },
    },
  };
}

function makeAccessSummary(opts: {
  name: string;
  file: string;
  accesses: Array<{
    table: string;
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
    output: { type: "return" },
    effects: opts.accesses.map(
      (a): Effect => ({
        type: "storageAccess",
        kind: a.kind,
        storageSystem: a.storageSystem ?? "postgres",
        scope: a.scope ?? "default",
        table: a.table,
        fields: a.fields,
        ...(a.selector !== undefined ? { selector: a.selector } : {}),
        ...(a.operation !== undefined ? { operation: a.operation } : {}),
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
      (f) => f.kind === "storageReadFieldUnknown",
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
      (f) => f.kind === "storageWriteFieldUnknown",
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
    const unused = findings.filter((f) => f.kind === "storageFieldUnused");
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
      (f) => f.kind === "storageWriteOnlyField",
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
        // findUnique({ where: { id } }) — no select → reads ALL fields
        accesses: [{ table: "User", kind: "read", fields: ["*"] }],
      }),
    ]);
    expect(findings.filter((f) => f.kind === "storageFieldUnused")).toEqual([]);
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
      findings.filter((f) => f.kind === "storageReadFieldUnknown"),
    ).toEqual([]);
  });

  it("scopes accesses by (storageSystem, scope, table)", () => {
    const findings = checkRelationalStorage([
      makeProvider({ table: "User", scope: "auth", columns: [{ name: "id" }] }),
      // Same table name, different scope — should NOT pair as a
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
      findings.filter((f) => f.kind === "storageReadFieldUnknown"),
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
      (f) => f.kind === "storageReadFieldUnknown",
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
