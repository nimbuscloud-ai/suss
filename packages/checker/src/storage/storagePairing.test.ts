import { describe, expect, it } from "vitest";

import { storageBinding } from "@suss/behavioral-ir";

import { checkStorage } from "./storagePairing.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Effect,
  Transition,
} from "@suss/behavioral-ir";

function makeProvider(opts: {
  container: string | null;
  storageSystem?: string;
  scope?: string;
  accessPath?: string | null;
  fields: Array<{ name: string; type?: string; nullable?: boolean }>;
  physicalTable?: string;
  /** A SQL schema declares every field, so that is the default here. */
  fieldSet?: "exhaustive" | "partial" | "none";
}): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: "schema.prisma",
      range: { start: 1, end: 10 },
      exportName: null,
    },
    identity: {
      name: opts.container ?? "<unnamed>",
      exportPath: null,
      boundaryBinding: storageBinding({
        recognition: "prisma",
        storageSystem: opts.storageSystem ?? "postgres",
        scope: opts.scope ?? "default",
        container: opts.container,
        accessPath: opts.accessPath ?? null,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      storageContract: {
        fieldSet: opts.fieldSet ?? "exhaustive",
        fields: opts.fields,
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
    container: string | null;
    storageSystem?: string;
    scope?: string;
    accessPath?: string | null;
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
        binding: storageBinding({
          recognition: "test",
          storageSystem: a.storageSystem ?? "postgres",
          scope: a.scope ?? "default",
          container: a.container,
          accessPath: a.accessPath ?? null,
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

describe("checkStorage", () => {
  it("keeps two services' same-named tables apart", () => {
    // Both services keep a users table under the scope "default", so
    // the pairing key alone puts them together and each schema used to
    // check the other service's queries.
    const provider = {
      ...makeProvider({ container: "users", fields: [{ name: "id" }] }),
      location: {
        file: "billing/schema.prisma",
        range: { start: 1, end: 10 },
        exportName: null,
        workspace: "billing",
      },
    };
    const access = {
      ...makeAccessSummary({
        name: "readProfile",
        file: "identity/src/handler.ts",
        accesses: [{ container: "users", kind: "read", fields: ["email"] }],
      }),
      location: {
        file: "identity/src/handler.ts",
        range: { start: 1, end: 20 },
        exportName: "readProfile",
        workspace: "identity",
      },
    };
    expect(
      checkStorage([provider, access]).filter(
        (f) => f.kind === "boundaryFieldUnknown",
      ),
    ).toEqual([]);
  });

  it("still pairs a schema and a query inside one service", () => {
    const provider = {
      ...makeProvider({ container: "users", fields: [{ name: "id" }] }),
      location: {
        file: "billing/schema.prisma",
        range: { start: 1, end: 10 },
        exportName: null,
        workspace: "billing",
      },
    };
    const access = {
      ...makeAccessSummary({
        name: "readProfile",
        file: "billing/src/handler.ts",
        accesses: [{ container: "users", kind: "read", fields: ["email"] }],
      }),
      location: {
        file: "billing/src/handler.ts",
        range: { start: 1, end: 20 },
        exportName: "readProfile",
        workspace: "billing",
      },
    };
    const findings = checkStorage([provider, access]).filter(
      (f) => f.kind === "boundaryFieldUnknown",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("email");
  });

  it("pairs nothing when the access states no table", () => {
    // A drizzle query whose table declaration the reader could not
    // settle. Pairing it by source text would check it against a
    // schema table that merely spells the same way.
    const provider = makeProvider({
      container: "users",
      fields: [{ name: "id" }, { name: "email" }],
    });
    const consumer = makeAccessSummary({
      name: "readMystery",
      file: "src/handler.ts",
      accesses: [{ container: null, kind: "read", fields: ["nonsense"] }],
    });
    const findings = checkStorage([provider, consumer]);
    expect(findings.filter((f) => f.kind === "boundaryFieldUnknown")).toEqual(
      [],
    );
  });

  it("claims no access when the provider states no table", () => {
    const provider = makeProvider({
      container: null,
      fields: [{ name: "id" }],
    });
    const consumer = makeAccessSummary({
      name: "readUsers",
      file: "src/handler.ts",
      accesses: [{ container: "users", kind: "read", fields: ["nonsense"] }],
    });
    expect(checkStorage([provider, consumer])).toEqual([]);
  });

  it("emits storageReadFieldUnknown when code reads an undeclared field", () => {
    const findings = checkStorage([
      makeProvider({
        container: "User",
        fields: [{ name: "id" }, { name: "email" }],
      }),
      makeAccessSummary({
        name: "getUser",
        file: "src/getUser.ts",
        accesses: [
          { container: "User", kind: "read", fields: ["email", "deltedAt"] },
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

  it("says nothing about an undeclared field when the contract declares only some of them", () => {
    const findings = checkStorage([
      makeProvider({
        container: "Orders",
        storageSystem: "dynamodb",
        fieldSet: "partial",
        fields: [{ name: "pk" }, { name: "sk" }],
      }),
      makeAccessSummary({
        name: "getOrder",
        file: "src/getOrder.ts",
        accesses: [
          {
            container: "Orders",
            storageSystem: "dynamodb",
            kind: "read",
            fields: ["pk", "shippedAt"],
          },
        ],
      }),
    ]);
    expect(findings.filter((f) => f.kind === "boundaryFieldUnknown")).toEqual(
      [],
    );
  });

  it("leaves a query against the table alone when only an index declares the field", () => {
    const findings = checkStorage([
      makeProvider({
        container: "Orders",
        storageSystem: "dynamodb",
        accessPath: "byCustomer",
        fields: [{ name: "customerId" }],
      }),
      makeAccessSummary({
        name: "listOrders",
        file: "src/listOrders.ts",
        accesses: [
          {
            container: "Orders",
            storageSystem: "dynamodb",
            kind: "read",
            fields: ["customerId", "orderId"],
          },
        ],
      }),
    ]);
    expect(findings.filter((f) => f.kind === "boundaryFieldUnknown")).toEqual(
      [],
    );
  });

  it("checks a query through an index against that index's own fields", () => {
    const findings = checkStorage([
      makeProvider({
        container: "Orders",
        storageSystem: "dynamodb",
        accessPath: "byCustomer",
        fields: [{ name: "customerId" }],
      }),
      makeAccessSummary({
        name: "listByCustomer",
        file: "src/listByCustomer.ts",
        accesses: [
          {
            container: "Orders",
            storageSystem: "dynamodb",
            accessPath: "byCustomer",
            kind: "read",
            fields: ["customerId", "orderId"],
          },
        ],
      }),
    ]);
    const unknown = findings.filter((f) => f.kind === "boundaryFieldUnknown");
    expect(unknown).toHaveLength(1);
    expect(unknown[0].description).toContain("orderId");
    expect(unknown[0].description).toContain("Orders#byCustomer");
  });

  it("emits storageWriteFieldUnknown when code writes an undeclared field", () => {
    const findings = checkStorage([
      makeProvider({
        container: "User",
        fields: [{ name: "id" }, { name: "email" }],
      }),
      makeAccessSummary({
        name: "createUser",
        file: "src/createUser.ts",
        accesses: [
          { container: "User", kind: "write", fields: ["email", "role"] },
        ],
      }),
    ]);
    const unknown = findings.filter(
      (f) => f.kind === "boundaryFieldUnknown" && f.aspect === "write",
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0].description).toContain("role");
  });

  it("emits storageFieldUnused for fields no caller touches", () => {
    const findings = checkStorage([
      makeProvider({
        container: "User",
        fields: [{ name: "id" }, { name: "email" }, { name: "deletedAt" }],
      }),
      makeAccessSummary({
        name: "h",
        file: "src/h.ts",
        accesses: [
          { container: "User", kind: "read", fields: ["id", "email"] },
        ],
      }),
    ]);
    const unused = findings.filter(
      (f) => f.kind === "boundaryFieldUnused" && f.aspect === undefined,
    );
    expect(unused).toHaveLength(1);
    expect(unused[0].description).toContain("deletedAt");
    expect(unused[0].severity).toBe("warning");
  });

  it("emits storageWriteOnlyField when a field is written but never read", () => {
    const findings = checkStorage([
      makeProvider({
        container: "User",
        fields: [{ name: "id" }, { name: "lastLoginAt" }],
      }),
      makeAccessSummary({
        name: "recordLogin",
        file: "src/recordLogin.ts",
        accesses: [
          { container: "User", kind: "write", fields: ["lastLoginAt"] },
        ],
      }),
      makeAccessSummary({
        name: "getUser",
        file: "src/getUser.ts",
        accesses: [{ container: "User", kind: "read", fields: ["id"] }],
      }),
    ]);
    const writeOnly = findings.filter(
      (f) => f.kind === "boundaryFieldUnused" && f.aspect === "read",
    );
    expect(writeOnly).toHaveLength(1);
    expect(writeOnly[0].description).toContain("lastLoginAt");
  });

  it("suppresses unused-column checks when ANY caller uses default-shape reads", () => {
    const findings = checkStorage([
      makeProvider({
        container: "User",
        fields: [{ name: "id" }, { name: "email" }, { name: "deletedAt" }],
      }),
      makeAccessSummary({
        name: "getUserAll",
        file: "src/getUserAll.ts",
        // findUnique({ where: { id } }): no select → reads ALL fields
        accesses: [{ container: "User", kind: "read", fields: ["*"] }],
      }),
    ]);
    expect(
      findings.filter(
        (f) => f.kind === "boundaryFieldUnused" && f.aspect === undefined,
      ),
    ).toEqual([]);
  });

  it("default-shape reads do NOT fire field-unknown findings", () => {
    const findings = checkStorage([
      makeProvider({ container: "User", fields: [{ name: "id" }] }),
      makeAccessSummary({
        name: "h",
        file: "src/h.ts",
        accesses: [{ container: "User", kind: "read", fields: ["*"] }],
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
    const findings = checkStorage([
      makeProvider({
        container: "User",
        physicalTable: "users",
        fields: [{ name: "id" }, { name: "email" }],
      }),
      makeAccessSummary({
        name: "listUsers",
        file: "src/list.ts",
        accesses: [
          {
            container: "users",
            kind: "read",
            fields: ["email", "nonExistent"],
          },
          { container: "User", kind: "read", fields: ["id"] },
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
    const findings = checkStorage([
      makeProvider({
        container: "User",
        scope: "auth",
        fields: [{ name: "id" }],
      }),
      // Same table name, different scope, should NOT pair as a
      // read-field-unknown finding even though "nonExistent" isn't
      // declared on the auth-scope provider.
      makeAccessSummary({
        name: "h",
        file: "src/h.ts",
        accesses: [
          {
            container: "User",
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
    const findings = checkStorage([
      makeProvider({ container: "User", fields: [{ name: "email" }] }),
      makeProvider({ container: "Order", fields: [{ name: "id" }] }),
      makeAccessSummary({
        name: "h",
        file: "src/h.ts",
        accesses: [
          { container: "User", kind: "read", fields: ["email", "deltedAt"] },
          { container: "Order", kind: "read", fields: ["id", "total"] },
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
    const findings = checkStorage([
      makeProvider({
        container: "User",
        fields: [{ name: "id" }, { name: "email" }],
      }),
      makeAccessSummary({
        name: "create",
        file: "src/create.ts",
        accesses: [
          { container: "User", kind: "write", fields: ["id", "email"] },
        ],
      }),
      makeAccessSummary({
        name: "read",
        file: "src/read.ts",
        accesses: [
          { container: "User", kind: "read", fields: ["id", "email"] },
        ],
      }),
    ]);
    expect(findings).toEqual([]);
  });
});
