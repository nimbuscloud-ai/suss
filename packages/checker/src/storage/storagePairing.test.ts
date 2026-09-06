import { describe, expect, it } from "vitest";

import {
  runtimeConfigBinding,
  storageBinding,
  withRuntimeContractMetadata,
} from "@suss/behavioral-ir";

import { groundReferences } from "./grounding.js";
import { checkStorage, groundStorageAccesses } from "./storagePairing.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Effect,
  Transition,
} from "@suss/behavioral-ir";
import type { ComparedPair } from "../pairing/comparedPair.js";

function makeProvider(opts: {
  container: string | null;
  storageSystem?: string;
  scope?: string;
  accessPath?: string | null;
  fields: Array<{
    name: string;
    type?: string;
    nullable?: boolean;
    derived?: boolean;
    relationKey?: string[];
    joinContainer?: string;
  }>;
  physicalTable?: string;
  /** A SQL schema declares every field, so that is the default here. */
  fieldSet?: "exhaustive" | "partial" | "none";
  keyFields?: string[];
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
        storageSystem: opts.storageSystem ?? "postgresql",
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
        ...(opts.keyFields !== undefined
          ? { identifies: { kind: "keyFields", fields: opts.keyFields } }
          : {}),
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
    relationPath?: string[];
    relationKey?: true;
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
          storageSystem: a.storageSystem ?? "postgresql",
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
          ...(a.relationPath !== undefined
            ? { relationPath: a.relationPath }
            : {}),
          ...(a.relationKey === true ? { relationKey: true } : {}),
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
        storageSystem: "aws.dynamodb",
        fieldSet: "partial",
        fields: [{ name: "pk" }, { name: "sk" }],
      }),
      makeAccessSummary({
        name: "getOrder",
        file: "src/getOrder.ts",
        accesses: [
          {
            container: "Orders",
            storageSystem: "aws.dynamodb",
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
        storageSystem: "aws.dynamodb",
        accessPath: "byCustomer",
        fields: [{ name: "customerId" }],
      }),
      makeAccessSummary({
        name: "listOrders",
        file: "src/listOrders.ts",
        accesses: [
          {
            container: "Orders",
            storageSystem: "aws.dynamodb",
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
        storageSystem: "aws.dynamodb",
        accessPath: "byCustomer",
        fields: [{ name: "customerId" }],
      }),
      makeAccessSummary({
        name: "listByCustomer",
        file: "src/listByCustomer.ts",
        accesses: [
          {
            container: "Orders",
            storageSystem: "aws.dynamodb",
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

  it("pairs an access that spells a name the template builds at deploy time", () => {
    // Nothing reports the read field, since a table's contract is
    // partial. The two sides meeting shows in the declared key being
    // read rather than sitting unused.
    const findings = checkStorage([
      makeProvider({
        container: "OrdersTable",
        storageSystem: "aws.dynamodb",
        fieldSet: "partial",
        physicalTable: "{StageName}-orders-v1",
        fields: [{ name: "orderId" }],
      }),
      makeAccessSummary({
        name: "getOrder",
        file: "src/getOrder.ts",
        accesses: [
          {
            container: "prod-orders-v1",
            storageSystem: "aws.dynamodb",
            kind: "read",
            fields: ["orderId", "shippedAt"],
          },
        ],
      }),
    ]);

    expect(findings).toEqual([]);
  });

  it("leaves an access alone whose name the template's pattern does not fit", () => {
    const findings = checkStorage([
      makeProvider({
        container: "OrdersTable",
        storageSystem: "aws.dynamodb",
        fieldSet: "partial",
        physicalTable: "{StageName}-orders-v1",
        fields: [{ name: "orderId" }],
      }),
      makeAccessSummary({
        name: "getInvoice",
        file: "src/getInvoice.ts",
        accesses: [
          {
            container: "prod-invoices-v1",
            storageSystem: "aws.dynamodb",
            kind: "read",
            fields: ["invoiceId"],
          },
        ],
      }),
    ]);

    // The point is that the access is not attributed to this table.
    // Nothing reaches the table in this run, so it says nothing about
    // its fields either.
    expect(findings).toEqual([]);
  });

  it("reports a query that picks items by something the container does not key on", () => {
    const findings = checkStorage([
      makeProvider({
        container: "Orders",
        storageSystem: "aws.dynamodb",
        fieldSet: "partial",
        keyFields: ["orderId"],
        fields: [{ name: "orderId" }],
      }),
      makeAccessSummary({
        name: "byCustomer",
        file: "src/byCustomer.ts",
        accesses: [
          {
            container: "Orders",
            storageSystem: "aws.dynamodb",
            kind: "read",
            fields: ["*"],
            selector: ["customerId"],
          },
        ],
      }),
    ]);

    const mismatch = findings.filter(
      (f) => f.kind === "boundarySelectorMismatch",
    );
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0].severity).toBe("error");
    expect(mismatch[0].description).toContain("customerId");
  });

  it("says nothing about a query that keys on what the container keys on", () => {
    const findings = checkStorage([
      makeProvider({
        container: "Orders",
        storageSystem: "aws.dynamodb",
        fieldSet: "partial",
        keyFields: ["orderId", "placedAt"],
        fields: [{ name: "orderId" }, { name: "placedAt" }],
      }),
      makeAccessSummary({
        name: "recent",
        file: "src/recent.ts",
        accesses: [
          {
            container: "Orders",
            storageSystem: "aws.dynamodb",
            kind: "read",
            fields: ["*"],
            selector: ["orderId", "placedAt"],
          },
        ],
      }),
    ]);

    expect(
      findings.filter((f) => f.kind === "boundarySelectorMismatch"),
    ).toEqual([]);
  });

  it("claims nothing about a selector when the contract does not say what identifies an item", () => {
    const findings = checkStorage([
      makeProvider({
        container: "users",
        fields: [{ name: "id" }, { name: "email" }],
      }),
      makeAccessSummary({
        name: "readUser",
        file: "src/readUser.ts",
        accesses: [
          {
            container: "users",
            kind: "read",
            fields: ["email"],
            selector: ["email"],
          },
        ],
      }),
    ]);

    expect(
      findings.filter((f) => f.kind === "boundarySelectorMismatch"),
    ).toEqual([]);
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
    expect(unused[0].description).toContain(
      "suss counts a column as read only when a query selects it",
    );
    expect(unused[0].severity).toBe("warning");
  });

  it("leaves a field the store serves without keeping it out of both checks", () => {
    const findings = checkStorage([
      makeProvider({
        container: "User",
        fields: [
          { name: "id" },
          { name: "email" },
          { name: "posts", derived: true },
        ],
      }),
      makeAccessSummary({
        name: "h",
        file: "src/h.ts",
        accesses: [
          { container: "User", kind: "read", fields: ["id", "email"] },
        ],
      }),
    ]);

    expect(
      findings.filter((f) => f.description.includes("posts")),
    ).toHaveLength(0);
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
    expect(writeOnly[0].description).toContain("no query reads it");
    expect(writeOnly[0].description).toContain(
      "before you treat the write as pointless",
    );
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

describe("an access whose unit was told which store to reach", () => {
  /** A wrapper that takes the table as an argument and reads from it. */
  function wrapper(): BehavioralSummary {
    const summary = makeAccessSummary({
      name: "readRow",
      file: "src/storage.ts",
      accesses: [
        { container: "{location.table}", kind: "read", fields: ["email"] },
      ],
    });
    return {
      ...summary,
      identity: { ...summary.identity, id: "repo::src/storage.ts::readRow" },
      inputs: [
        {
          type: "parameter",
          name: "location",
          position: 0,
          role: null,
          shape: null,
        },
      ],
    };
  }

  /** A unit that calls the wrapper and says which table. */
  function caller(table: unknown): BehavioralSummary {
    const summary = makeAccessSummary({
      name: "listUsers",
      file: "src/handler.ts",
      accesses: [],
    });
    return {
      ...summary,
      transitions: [
        {
          id: "t0",
          conditions: [],
          output: { type: "return", value: null },
          effects: [
            {
              type: "invocation",
              callee: "readRow",
              summary: "repo::src/storage.ts::readRow",
              args: [{ kind: "object", fields: { table } }],
              async: true,
            },
          ],
          location: { start: 5, end: 10 },
          isDefault: true,
        },
      ],
    };
  }

  it("pairs the wrapper against the table its caller passed", () => {
    const provider = makeProvider({
      container: "users",
      fields: [{ name: "id" }],
    });
    const findings = checkStorage([
      provider,
      wrapper(),
      caller({ kind: "string", value: "users" }),
    ]).filter((f) => f.kind === "boundaryFieldUnknown");

    expect(findings).toHaveLength(1);
    expect(findings[0]?.description).toContain("email");
  });

  it("reads a table a caller builds at deploy time as the same pattern", () => {
    const provider = makeProvider({
      container: "{stage}-users",
      fields: [{ name: "id" }],
    });
    const findings = checkStorage([
      provider,
      wrapper(),
      caller({ kind: "template", sourceText: "`${stage}-users`" }),
    ]).filter((f) => f.kind === "boundaryFieldUnknown");

    expect(findings).toHaveLength(1);
  });

  it("pairs with nothing when the caller passes a table nobody can settle", () => {
    const provider = makeProvider({
      container: "users",
      fields: [{ name: "id" }],
    });

    expect(
      checkStorage([
        provider,
        wrapper(),
        caller({ kind: "identifier", name: "whicheverTable" }),
      ]).filter((f) => f.kind === "boundaryFieldUnknown"),
    ).toEqual([]);
  });

  it("pairs with nothing when nobody calls the wrapper", () => {
    const provider = makeProvider({
      container: "users",
      fields: [{ name: "id" }],
    });

    expect(
      checkStorage([provider, wrapper()]).filter(
        (f) => f.kind === "boundaryFieldUnknown",
      ),
    ).toEqual([]);
  });

  it("reports the grounded pair with the caller that supplied the name", () => {
    const provider = makeProvider({
      container: "users",
      fields: [{ name: "id" }],
    });
    const grounded = groundStorageAccesses([
      provider,
      wrapper(),
      caller({ kind: "string", value: "users" }),
    ]);
    const access = grounded.accesses.find(
      (record) => record.container === "{location.table}",
    );

    expect(access?.reached).toHaveLength(1);
    expect(access?.reached[0]?.name).toBe("users");
    expect(access?.reached[0]?.groundedBy?.role).toBe("caller");
    expect(access?.reached[0]?.groundedBy?.summary.identity.name).toBe(
      "listUsers",
    );
    expect(access?.providers.map((p) => p.identity.name)).toEqual(["users"]);
  });

  it("says a caller's argument would ground a reference nobody settles", () => {
    const grounded = groundStorageAccesses([wrapper()]).accesses;

    expect(grounded).toHaveLength(1);
    expect(grounded[0]?.reached).toEqual([]);
    expect(grounded[0]?.ungrounded).toEqual({ variable: null });
  });

  it("reaches one name when two callers pass the same table", () => {
    const second = caller({ kind: "string", value: "users" });
    second.identity = { ...second.identity, name: "countUsers" };
    second.location = { ...second.location, file: "src/report.ts" };
    const grounded = groundStorageAccesses([
      wrapper(),
      caller({ kind: "string", value: "users" }),
      second,
    ]).accesses;

    expect(grounded[0]?.reached.map((r) => r.name)).toEqual(["users"]);
  });

  it("skips an access whose container nobody could read", () => {
    const grounded = groundStorageAccesses([
      makeAccessSummary({
        name: "readSomething",
        file: "src/somewhere.ts",
        accesses: [{ container: null, kind: "read", fields: [] }],
      }),
    ]);

    expect(grounded.accesses).toEqual([]);
  });

  it("grounds nothing for a null reference, and no variable either", () => {
    const unit = wrapper();
    const grounding = groundReferences([unit]);

    expect(grounding.groundedNamesFor(unit, null)).toEqual([]);
    expect(grounding.namesFor(unit, null)).toEqual([]);
    expect(grounding.variableFor(unit, null)).toBeNull();
  });

  it("keeps namesFor unique when one caller says the table twice", () => {
    const unit = wrapper();
    const once = caller({ kind: "string", value: "users" });
    const twice = {
      ...once,
      transitions: [once.transitions[0], { ...once.transitions[0], id: "t1" }],
    };
    const grounding = groundReferences([unit, twice]);
    const reference = { root: "location", fields: ["table"] };

    expect(grounding.groundedNamesFor(unit, reference)).toHaveLength(1);
    expect(grounding.namesFor(unit, reference)).toEqual(["users"]);
  });

  it("leaves a reference alone whose root is no parameter of the unit", () => {
    const unit = wrapper();
    const grounding = groundReferences([
      unit,
      caller({ kind: "string", value: "users" }),
    ]);

    expect(
      grounding.namesFor(unit, { root: "settings", fields: ["table"] }),
    ).toEqual([]);
  });

  it("gets nothing from a caller that passes one string for the location", () => {
    const unit = wrapper();
    const flat = caller({ kind: "string", value: "users" });
    flat.transitions = [
      {
        ...flat.transitions[0],
        effects: [
          {
            type: "invocation",
            callee: "readRow",
            summary: "repo::src/storage.ts::readRow",
            args: [{ kind: "string", value: "users" }],
            async: true,
          },
        ],
      },
    ];
    const grounding = groundReferences([unit, flat]);

    expect(
      grounding.namesFor(unit, { root: "location", fields: ["table"] }),
    ).toEqual([]);
  });
});

describe("an index that copies part of an item", () => {
  /** What terraform says an INCLUDE index can serve. */
  function narrowIndex(): BehavioralSummary {
    return makeProvider({
      container: "ledger-v2",
      storageSystem: "aws.dynamodb",
      accessPath: "by-tenant-v2",
      fieldSet: "exhaustive",
      keyFields: ["tenant_id", "created_at"],
      fields: [
        { name: "tenant_id" },
        { name: "created_at" },
        { name: "entry_id" },
        { name: "status" },
        { name: "headline" },
      ],
    });
  }

  it("reports a query that reads a field the index does not copy", () => {
    const feed = makeAccessSummary({
      name: "recentForTenant",
      file: "src/feed.ts",
      accesses: [
        {
          container: "ledger-v2",
          storageSystem: "aws.dynamodb",
          accessPath: "by-tenant-v2",
          kind: "read",
          fields: ["status", "headline", "receipt_id"],
          selector: ["tenant_id"],
        },
      ],
    });
    const findings = checkStorage([narrowIndex(), feed]).filter(
      (f) => f.kind === "boundaryFieldUnknown",
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.description).toContain("receipt_id");
  });

  it("says nothing when the query reads only what the index copies", () => {
    const feed = makeAccessSummary({
      name: "recentForTenant",
      file: "src/feed.ts",
      accesses: [
        {
          container: "ledger-v2",
          storageSystem: "aws.dynamodb",
          accessPath: "by-tenant-v2",
          kind: "read",
          fields: ["status", "headline"],
          selector: ["tenant_id"],
        },
      ],
    });

    expect(
      checkStorage([narrowIndex(), feed]).filter(
        (f) => f.kind === "boundaryFieldUnknown",
      ),
    ).toEqual([]);
  });

  it("leaves a read of the table itself alone, since any attribute may be there", () => {
    const table = makeProvider({
      container: "ledger-v2",
      storageSystem: "aws.dynamodb",
      fieldSet: "partial",
      keyFields: ["entry_id", "created_at"],
      fields: [{ name: "entry_id" }, { name: "created_at" }],
    });
    const byId = makeAccessSummary({
      name: "readEdition",
      file: "src/edition.ts",
      accesses: [
        {
          container: "ledger-v2",
          storageSystem: "aws.dynamodb",
          kind: "read",
          fields: ["receipt_id"],
          selector: ["entry_id"],
        },
      ],
    });

    expect(
      checkStorage([table, byId]).filter(
        (f) => f.kind === "boundaryFieldUnknown",
      ),
    ).toEqual([]);
  });
});

describe("a read of whole items through an index that copies part of one", () => {
  it("reports it, since the store sends what it has and says nothing", () => {
    const index = makeProvider({
      container: "ledger-v2",
      storageSystem: "aws.dynamodb",
      accessPath: "by-tenant-v2",
      fieldSet: "exhaustive",
      keyFields: ["tenant_id"],
      fields: [{ name: "tenant_id" }, { name: "status" }],
    });
    const feed = makeAccessSummary({
      name: "recentForTenant",
      file: "src/feed.ts",
      accesses: [
        {
          container: "ledger-v2",
          storageSystem: "aws.dynamodb",
          accessPath: "by-tenant-v2",
          kind: "read",
          fields: ["*"],
          selector: ["tenant_id"],
        },
      ],
    });
    const findings = checkStorage([index, feed]).filter(
      (f) => f.kind === "boundaryFieldUnknown",
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.description).toContain("whole items");
  });

  it("leaves a whole-item read of a table alone", () => {
    const table = makeProvider({
      container: "users",
      fields: [{ name: "id" }, { name: "email" }],
    });
    const all = makeAccessSummary({
      name: "listUsers",
      file: "src/users.ts",
      accesses: [{ container: "users", kind: "read", fields: ["*"] }],
    });

    expect(
      checkStorage([table, all]).filter(
        (f) => f.kind === "boundaryFieldUnknown",
      ),
    ).toEqual([]);
  });
});

describe("a run with a contract and no code against it", () => {
  it("says nothing about which fields go unused, since it saw no code", () => {
    const table = makeProvider({
      container: "users",
      fields: [{ name: "id" }, { name: "email" }],
    });

    expect(checkStorage([table])).toEqual([]);
  });

  it("says nothing about a store this run has no code for", () => {
    const untouched = makeProvider({
      container: "audit_log",
      fields: [{ name: "id" }],
    });
    const users = makeProvider({
      container: "users",
      fields: [{ name: "id" }],
    });
    const reader = makeAccessSummary({
      name: "readUser",
      file: "src/users.ts",
      accesses: [{ container: "users", kind: "read", fields: ["id"] }],
    });

    expect(
      checkStorage([untouched, users, reader]).filter((f) =>
        f.description.includes("audit_log"),
      ),
    ).toEqual([]);
  });

  it("still says a field goes unused when code reaches the store", () => {
    const table = makeProvider({
      container: "users",
      fields: [{ name: "id" }, { name: "email" }],
    });
    const reader = makeAccessSummary({
      name: "readUser",
      file: "src/users.ts",
      accesses: [{ container: "users", kind: "read", fields: ["id"] }],
    });
    const unused = checkStorage([table, reader]).filter(
      (f) => f.kind === "boundaryFieldUnused",
    );

    expect(unused).toHaveLength(1);
    expect(unused[0]?.description).toContain("email");
  });
});

describe("a read written under another table's query", () => {
  /** An article, with the relation a comment query is written under. */
  function article(): BehavioralSummary {
    return makeProvider({
      container: "Article",
      fields: [
        { name: "id" },
        { name: "slug" },
        { name: "comments", type: "Comment[]", derived: true },
      ],
    });
  }

  function comment(): BehavioralSummary {
    return makeProvider({
      container: "Comment",
      fields: [
        { name: "id" },
        { name: "body" },
        { name: "authorId" },
        { name: "author", type: "User", derived: true },
      ],
    });
  }

  function unusedOf(summaries: BehavioralSummary[]): string[] {
    return checkStorage(summaries)
      .filter((f) => f.kind === "boundaryFieldUnused")
      .map((f) => f.description);
  }

  it("counts the fields against the table the relation reaches", () => {
    const reader = makeAccessSummary({
      name: "getComments",
      file: "src/article.service.ts",
      accesses: [
        { container: "Article", kind: "read", fields: ["*"] },
        {
          container: "Article",
          kind: "read",
          fields: ["id", "body"],
          relationPath: ["comments"],
        },
      ],
    });
    const unused = unusedOf([article(), comment(), reader]);

    expect(unused).toHaveLength(1);
    expect(unused[0]).toContain("authorId");
    expect(unused[0]).not.toContain('"body"');
  });

  it("says nothing is unknown about the table the query was written on", () => {
    const reader = makeAccessSummary({
      name: "getComments",
      file: "src/article.service.ts",
      accesses: [
        {
          container: "Article",
          kind: "read",
          fields: ["body"],
          relationPath: ["comments"],
        },
      ],
    });

    expect(
      checkStorage([article(), comment(), reader]).filter(
        (f) => f.kind === "boundaryFieldUnknown",
      ),
    ).toEqual([]);
  });

  it("follows a relation asked for through another relation", () => {
    const user = makeProvider({
      container: "User",
      fields: [{ name: "id" }, { name: "username" }],
    });
    const reader = makeAccessSummary({
      name: "getComments",
      file: "src/article.service.ts",
      accesses: [
        {
          container: "Article",
          kind: "read",
          fields: ["username"],
          relationPath: ["comments", "author"],
        },
      ],
    });
    const unused = unusedOf([article(), comment(), user, reader]);

    expect(unused).toHaveLength(1);
    expect(unused[0]).toContain('"id"');
    expect(unused[0]).toContain("User");
  });

  it("reads every field of the related record when the query asks for no field", () => {
    const reader = makeAccessSummary({
      name: "getArticle",
      file: "src/article.service.ts",
      accesses: [
        {
          container: "Article",
          kind: "read",
          fields: ["*"],
          relationPath: ["comments"],
        },
      ],
    });

    expect(unusedOf([article(), comment(), reader])).toEqual([]);
  });

  it("leaves the read out when the contract declares no such relation", () => {
    // `_count` is a Prisma aggregate rather than a column, and putting
    // its fields on the table the query addressed would call them read
    // there.
    const reader = makeAccessSummary({
      name: "getArticle",
      file: "src/article.service.ts",
      accesses: [
        { container: "Article", kind: "read", fields: ["id"] },
        {
          container: "Article",
          kind: "read",
          fields: ["comments"],
          relationPath: ["_count"],
        },
      ],
    });
    const findings = checkStorage([article(), reader]);

    expect(findings.filter((f) => f.kind === "boundaryFieldUnknown")).toEqual(
      [],
    );
    expect(
      findings
        .filter((f) => f.kind === "boundaryFieldUnused")
        .map((f) => f.description)
        .join(" "),
    ).toContain("slug");
  });

  it("leaves the read out when the run has no contract for the table", () => {
    const reader = makeAccessSummary({
      name: "getComments",
      file: "src/article.service.ts",
      accesses: [
        {
          container: "Article",
          kind: "read",
          fields: ["id", "body"],
          relationPath: ["comments"],
        },
      ],
    });

    expect(checkStorage([comment(), reader])).toEqual([]);
  });
});

describe("a write written under another table's data", () => {
  /** An article, with the relation a nested tag write is written under. */
  function article(): BehavioralSummary {
    return makeProvider({
      container: "Article",
      fields: [
        { name: "id" },
        { name: "title" },
        { name: "tagList", type: "Tag[]", derived: true },
      ],
    });
  }

  function tag(): BehavioralSummary {
    return makeProvider({
      container: "Tag",
      fields: [{ name: "id" }, { name: "name" }],
    });
  }

  function writer(fields: string[], relationPath: string[]): BehavioralSummary {
    return makeAccessSummary({
      name: "createArticle",
      file: "src/article.service.ts",
      accesses: [
        { container: "Article", kind: "write", fields: ["title"] },
        {
          container: "Article",
          kind: "write",
          fields,
          relationPath,
          operation: "connectOrCreate",
        },
      ],
    });
  }

  it("counts the fields against the table the relation reaches", () => {
    const findings = checkStorage([
      article(),
      tag(),
      writer(["name"], ["tagList"]),
    ]);
    const descriptions = findings.map((f) => f.description);

    expect(findings.filter((f) => f.kind === "boundaryFieldUnknown")).toEqual(
      [],
    );
    expect(descriptions.join(" ")).toContain('Tag declares "name" and code');
    expect(descriptions.join(" ")).not.toContain('Article declares "name"');
  });

  it("makes no per-column claim when the payload was built elsewhere", () => {
    const descriptions = checkStorage([
      article(),
      tag(),
      writer(["*"], ["tagList"]),
    ]).map((f) => f.description);

    expect(descriptions.join(" ")).not.toContain("Tag declares");
  });

  it("still reports a column another access writes by name", () => {
    const descriptions = checkStorage([
      article(),
      tag(),
      writer(["*"], ["tagList"]),
      makeAccessSummary({
        name: "renameTag",
        file: "src/tag.service.ts",
        accesses: [{ container: "Tag", kind: "write", fields: ["name"] }],
      }),
    ]).map((f) => f.description);

    expect(descriptions.join(" ")).toContain('Tag declares "name" and code');
    expect(descriptions.join(" ")).not.toContain('Tag declares "id"');
  });

  it("drops a write to a relation without saying anything about it", () => {
    // The pack records the path and the contract says which paths are
    // relations, so a contract in the run has already settled this. It
    // used to report the resolution, once per relation field, which on
    // a schema of any size buried the findings somebody can act on.
    const findings = checkStorage([
      article(),
      tag(),
      makeAccessSummary({
        name: "createArticle",
        file: "src/article.service.ts",
        accesses: [
          // What a pack emits when it reads a relation as a column.
          { container: "Article", kind: "write", fields: ["title", "tagList"] },
        ],
      }),
    ]);

    expect(findings.map((f) => f.description).join(" ")).not.toContain(
      "tagList",
    );
    expect(findings.filter((f) => f.severity === "info")).toEqual([]);
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("stays quiet when a write names only columns the store keeps", () => {
    const findings = checkStorage([
      article(),
      tag(),
      makeAccessSummary({
        name: "createArticle",
        file: "src/article.service.ts",
        accesses: [{ container: "Article", kind: "write", fields: ["title"] }],
      }),
    ]);

    expect(findings.filter((f) => f.severity === "info")).toEqual([]);
  });

  it("leaves the write out when the contract declares no such relation", () => {
    const findings = checkStorage([
      article(),
      tag(),
      writer(["name"], ["meta"]),
    ]);

    expect(findings.filter((f) => f.kind === "boundaryFieldUnknown")).toEqual(
      [],
    );
    expect(
      findings.map((f) => f.description).filter((d) => d.includes("Tag")),
    ).toEqual([]);
  });

  it("puts a grounded access on the table the relation reaches", () => {
    const { accesses } = groundStorageAccesses([
      article(),
      tag(),
      writer(["name"], ["tagList"]),
    ]);

    expect(
      accesses
        .filter((a) => a.kind === "write")
        .map((a) => a.container)
        .sort(),
    ).toEqual(["Article", "Tag"]);
  });
});

describe("a write that moves which row a relation joins", () => {
  /** A comment, which declares the foreign keys of both its relations. */
  function comment(): BehavioralSummary {
    return makeProvider({
      container: "Comment",
      fields: [
        { name: "id" },
        { name: "body" },
        { name: "articleId" },
        {
          name: "article",
          type: "Article",
          derived: true,
          relationKey: ["articleId"],
        },
      ],
    });
  }

  /** An article, whose side of the same relation declares no key. */
  function article(): BehavioralSummary {
    return makeProvider({
      container: "Article",
      fields: [
        { name: "id" },
        { name: "title" },
        { name: "comments", type: "Comment[]", derived: true },
        { name: "favoritedBy", type: "User[]", derived: true },
      ],
    });
  }

  function user(): BehavioralSummary {
    return makeProvider({
      container: "User",
      fields: [{ name: "id" }],
    });
  }

  function connects(
    container: string,
    relationPath: string[],
  ): BehavioralSummary {
    return makeAccessSummary({
      name: "addComment",
      file: "src/article.service.ts",
      accesses: [
        // A payload stating a relation and nothing else writes no
        // column the call itself could name.
        { container, kind: "write", fields: [] },
        {
          container,
          kind: "write",
          fields: [],
          relationPath,
          relationKey: true,
          operation: "connect",
        },
      ],
    });
  }

  function writtenOn(summaries: BehavioralSummary[], container: string) {
    return groundStorageAccesses(summaries)
      .accesses.filter(
        (access) => access.kind === "write" && access.container === container,
      )
      .flatMap((access) => access.binding.semantics);
  }

  it("writes the foreign key on the model that declares the relation", () => {
    const findings = checkStorage([
      article(),
      comment(),
      connects("Comment", ["article"]),
    ]);
    const descriptions = findings.map((f) => f.description).join(" ");

    expect(findings.filter((f) => f.kind === "boundaryFieldUnknown")).toEqual(
      [],
    );
    expect(descriptions).toContain('Comment declares "articleId" and code');
    expect(descriptions).not.toContain('Article declares "articleId"');
  });

  it("counts nothing when the key of that relation lives elsewhere", () => {
    const findings = checkStorage([
      article(),
      user(),
      connects("Article", ["favoritedBy"]),
    ]);

    const descriptions = findings.map((f) => f.description).join(" ");

    expect(findings.filter((f) => f.kind === "boundaryFieldUnknown")).toEqual(
      [],
    );
    expect(descriptions).not.toContain("code here writes to it");
    expect(descriptions).toContain('Article declares "id". No query here');
  });

  it("reads the key off the model the rest of the path arrives at", () => {
    const writer = makeAccessSummary({
      name: "createArticle",
      file: "src/article.service.ts",
      accesses: [
        { container: "Article", kind: "write", fields: ["title"] },
        {
          container: "Article",
          kind: "write",
          fields: [],
          relationPath: ["comments", "article"],
          relationKey: true,
          operation: "connect",
        },
      ],
    });
    const descriptions = checkStorage([article(), comment(), writer])
      .map((f) => f.description)
      .join(" ");

    expect(descriptions).toContain('Comment declares "articleId" and code');
  });

  it("takes a name the contract does not call a relation as a column", () => {
    const findings = checkStorage([
      article(),
      comment(),
      connects("Comment", ["nickname"]),
    ]);

    expect(
      findings
        .filter((f) => f.kind === "boundaryFieldUnknown")
        .map((f) => f.description)
        .join(" "),
    ).toContain("nickname");
  });

  it("takes a declared column written the long way as that column", () => {
    // Prisma spells a plain column update `{ body: { set: "x" } }`, and
    // only the contract tells that from a relation.
    const descriptions = checkStorage([
      article(),
      comment(),
      connects("Comment", ["body"]),
    ])
      .map((f) => f.description)
      .join(" ");

    expect(descriptions).toContain('Comment declares "body" and code');
  });

  it("leaves the write on the model the call addressed", () => {
    expect(
      writtenOn(
        [article(), comment(), connects("Comment", ["article"])],
        "Comment",
      ),
    ).toHaveLength(2);
    expect(
      writtenOn(
        [article(), comment(), connects("Comment", ["article"])],
        "Article",
      ),
    ).toEqual([]);
  });

  describe("an implicit many-to-many, where the schema names the join table", () => {
    /** An article whose favoritedBy field points at the join table. */
    function articleWithJoinTable(): BehavioralSummary {
      return makeProvider({
        container: "Article",
        fields: [
          { name: "id" },
          { name: "title" },
          {
            name: "favoritedBy",
            type: "User[]",
            derived: true,
            joinContainer: "_ArticleToUser",
          },
        ],
      });
    }

    /** The join table Prisma manages for Article's favoritedBy relation. */
    function articleToUserJoinTable(): BehavioralSummary {
      return makeProvider({
        container: "_ArticleToUser",
        fields: [
          { name: "A", type: "Article" },
          { name: "B", type: "User" },
        ],
      });
    }

    it("writes the join table's own columns instead of dropping the write", () => {
      const written = writtenOn(
        [
          articleWithJoinTable(),
          articleToUserJoinTable(),
          connects("Article", ["favoritedBy"]),
        ],
        "_ArticleToUser",
      );
      expect(written).toHaveLength(1);
    });

    it("reports the columns as write-only, since nothing here reads the join table", () => {
      const descriptions = checkStorage([
        articleWithJoinTable(),
        articleToUserJoinTable(),
        connects("Article", ["favoritedBy"]),
      ])
        .map((f) => f.description)
        .join(" ");

      expect(descriptions).toContain('_ArticleToUser declares "A"');
      expect(descriptions).toContain('_ArticleToUser declares "B"');
    });

    it("drops the write when nothing in the run declares that join table", () => {
      const findings = checkStorage([
        articleWithJoinTable(),
        connects("Article", ["favoritedBy"]),
      ]);

      expect(findings.filter((f) => f.kind === "boundaryFieldUnknown")).toEqual(
        [],
      );
      expect(
        writtenOn(
          [articleWithJoinTable(), connects("Article", ["favoritedBy"])],
          "_ArticleToUser",
        ),
      ).toEqual([]);
    });
  });
});

describe("an access whose store the deployment sets a variable to", () => {
  /** A Worker's runtime, with the variable its code addresses a store through. */
  function runtime(opts: {
    instanceName: string;
    codeScope: string;
    values: Record<string, string>;
  }): BehavioralSummary {
    const deployableUnit = {
      deploymentTarget: "worker" as const,
      instanceName: opts.instanceName,
    };
    return {
      kind: "library",
      location: {
        file: "wrangler.toml",
        range: { start: 1, end: 1 },
        exportName: null,
      },
      identity: {
        name: opts.instanceName,
        exportPath: null,
        boundaryBinding: runtimeConfigBinding({
          recognition: "wrangler",
          ...deployableUnit,
        }),
        deployableUnit,
      },
      inputs: [],
      transitions: [],
      gaps: [],
      confidence: { source: "declared", level: "high" },
      metadata: withRuntimeContractMetadata(
        { codeScope: { kind: "codeUri", path: opts.codeScope } },
        {
          envVars: Object.keys(opts.values).sort(),
          envVarValues: opts.values,
        },
      ),
    };
  }

  it("pairs an access against the store its variable is set to", () => {
    const findings = checkStorage([
      makeProvider({
        container: "prod-orders-v2",
        storageSystem: "aws.dynamodb",
        fields: [{ name: "id" }],
        fieldSet: "partial",
        keyFields: ["id"],
      }),
      runtime({
        instanceName: "order-router",
        codeScope: "services/orders",
        values: { ORDER_TABLE: "prod-orders-v2" },
      }),
      makeAccessSummary({
        name: "listOrders",
        file: "services/orders/src/dao.ts",
        accesses: [
          {
            container: "{ORDER_TABLE}",
            storageSystem: "aws.dynamodb",
            kind: "read",
            fields: ["id", "total"],
            selector: ["customerId"],
          },
        ],
      }),
    ]);

    const mismatch = findings.filter(
      (f) => f.kind === "boundarySelectorMismatch",
    );
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]?.description).toContain("customerId");
  });

  it("leaves an access outside the runtime's code alone", () => {
    const findings = checkStorage([
      makeProvider({
        container: "prod-orders-v2",
        storageSystem: "aws.dynamodb",
        fields: [{ name: "id" }],
        fieldSet: "partial",
        keyFields: ["id"],
      }),
      runtime({
        instanceName: "order-router",
        codeScope: "services/orders",
        values: { ORDER_TABLE: "prod-orders-v2" },
      }),
      makeAccessSummary({
        name: "listOrders",
        file: "services/billing/src/dao.ts",
        accesses: [
          {
            container: "{ORDER_TABLE}",
            storageSystem: "aws.dynamodb",
            kind: "read",
            fields: ["id"],
            selector: ["customerId"],
          },
        ],
      }),
    ]);
    expect(findings).toEqual([]);
  });

  it("reaches both stores when the same code is deployed twice", () => {
    const summaries = [
      makeProvider({
        container: "prod-orders-v2",
        storageSystem: "aws.dynamodb",
        fields: [{ name: "id" }],
        fieldSet: "partial",
        keyFields: ["id"],
      }),
      makeProvider({
        container: "staging-orders-v2",
        storageSystem: "aws.dynamodb",
        fields: [{ name: "id" }],
        fieldSet: "partial",
        keyFields: ["id"],
      }),
      runtime({
        instanceName: "order-router",
        codeScope: "services/orders",
        values: { ORDER_TABLE: "prod-orders-v2" },
      }),
      runtime({
        instanceName: "order-router-staging",
        codeScope: "services/orders",
        values: { ORDER_TABLE: "staging-orders-v2" },
      }),
      makeAccessSummary({
        name: "listOrders",
        file: "services/orders/src/dao.ts",
        accesses: [
          {
            container: "{ORDER_TABLE}",
            storageSystem: "aws.dynamodb",
            kind: "read",
            fields: ["id"],
            selector: ["customerId"],
          },
        ],
      }),
    ];

    const containers = checkStorage(summaries)
      .filter((f) => f.kind === "boundarySelectorMismatch")
      .map((f) => f.description);
    expect(containers.join("\n")).toContain("prod-orders-v2");
    expect(containers.join("\n")).toContain("staging-orders-v2");
  });

  it("reports the runtime that supplied the variable's value", () => {
    const grounded = groundStorageAccesses([
      runtime({
        instanceName: "order-router",
        codeScope: "services/orders",
        values: { ORDER_TABLE: "prod-orders-v2" },
      }),
      makeAccessSummary({
        name: "listOrders",
        file: "services/orders/src/dao.ts",
        accesses: [
          {
            container: "{ORDER_TABLE}",
            storageSystem: "aws.dynamodb",
            kind: "read",
            fields: ["id"],
          },
        ],
      }),
    ]).accesses;

    expect(grounded).toHaveLength(1);
    expect(grounded[0]?.reached[0]?.name).toBe("prod-orders-v2");
    expect(grounded[0]?.reached[0]?.groundedBy?.role).toBe("runtime");
    expect(grounded[0]?.reached[0]?.groundedBy?.summary.identity.name).toBe(
      "order-router",
    );
  });

  it("says which variable would ground an access nothing sets", () => {
    const grounded = groundStorageAccesses([
      makeAccessSummary({
        name: "listOrders",
        file: "services/orders/src/dao.ts",
        accesses: [
          {
            container: "{ORDER_TABLE}",
            storageSystem: "aws.dynamodb",
            kind: "read",
            fields: ["id"],
          },
        ],
      }),
    ]).accesses;

    expect(grounded[0]?.ungrounded).toEqual({ variable: "ORDER_TABLE" });
  });

  it("pairs an access that reads the variable off its config argument", () => {
    const handler = makeAccessSummary({
      name: "fetch",
      file: "services/orders/src/worker.ts",
      accesses: [
        {
          container: "{env.ORDER_TABLE}",
          storageSystem: "aws.dynamodb",
          kind: "read",
          fields: ["id"],
          selector: ["customerId"],
        },
      ],
    });
    const findings = checkStorage([
      makeProvider({
        container: "prod-orders-v2",
        storageSystem: "aws.dynamodb",
        fields: [{ name: "id" }],
        fieldSet: "partial",
        keyFields: ["id"],
      }),
      runtime({
        instanceName: "order-router",
        codeScope: "services/orders",
        values: { ORDER_TABLE: "prod-orders-v2" },
      }),
      {
        ...handler,
        inputs: [
          {
            type: "parameter",
            name: "env",
            position: 1,
            role: "config",
            shape: null,
          },
        ],
      },
    ]);

    const mismatch = findings.filter(
      (f) => f.kind === "boundarySelectorMismatch",
    );
    expect(mismatch).toHaveLength(1);
  });

  it("leaves a field of an ordinary argument to the callers", () => {
    const findings = checkStorage([
      makeProvider({
        container: "prod-orders-v2",
        storageSystem: "aws.dynamodb",
        fields: [{ name: "id" }],
        fieldSet: "partial",
        keyFields: ["id"],
      }),
      runtime({
        instanceName: "order-router",
        codeScope: "services/orders",
        values: { ORDER_TABLE: "prod-orders-v2" },
      }),
      makeAccessSummary({
        name: "readRow",
        file: "services/orders/src/dao.ts",
        accesses: [
          {
            container: "{location.ORDER_TABLE}",
            storageSystem: "aws.dynamodb",
            kind: "read",
            fields: ["id"],
            selector: ["customerId"],
          },
        ],
      }),
    ]);
    expect(findings).toEqual([]);
  });

  it("says nothing about a variable no deployment sets", () => {
    const findings = checkStorage([
      makeProvider({
        container: "prod-orders-v2",
        storageSystem: "aws.dynamodb",
        fields: [{ name: "id" }],
        fieldSet: "partial",
        keyFields: ["id"],
      }),
      runtime({
        instanceName: "order-router",
        codeScope: "services/orders",
        values: { SOMETHING_ELSE: "prod-orders-v2" },
      }),
      makeAccessSummary({
        name: "listOrders",
        file: "services/orders/src/dao.ts",
        accesses: [
          {
            container: "{ORDER_TABLE}",
            storageSystem: "aws.dynamodb",
            kind: "read",
            fields: ["id"],
            selector: ["customerId"],
          },
        ],
      }),
    ]);
    expect(findings).toEqual([]);
  });
});

describe("a name two declared tables could both be", () => {
  /** A table a module declares under a name the deployment finishes. */
  function table(container: string, physical: string, key: string) {
    return makeProvider({
      container,
      storageSystem: "aws.dynamodb",
      fieldSet: "partial",
      physicalTable: physical,
      keyFields: [key],
      fields: [{ name: key }],
    });
  }

  function listing(container: string, selector: string) {
    return makeAccessSummary({
      name: "listEditions",
      file: "src/editions.ts",
      accesses: [
        {
          container,
          storageSystem: "aws.dynamodb",
          kind: "read",
          fields: ["*"],
          selector: [selector],
        },
      ],
    });
  }

  it("pairs with the table whose name states more of what the access reached", () => {
    const compared: ComparedPair[] = [];
    const findings = checkStorage(
      [
        table("PublicationsTable", "{Env}-publications-v1", "pk"),
        table(
          "CreatorPublicationsTable",
          "{Env}-creator-publications-v1",
          "creatorId",
        ),
        listing("prod-creator-publications-v1", "creatorId"),
      ],
      undefined,
      compared,
    );

    expect(findings).toEqual([]);
    expect(compared.map((pair) => pair.key)).toEqual([
      "aws.dynamodb:CreatorPublicationsTable",
    ]);
  });

  it("pairs with neither when the two state as much as each other, and says so", () => {
    const compared: ComparedPair[] = [];
    const findings = checkStorage(
      [
        table("OrdersBlue", "{StageName}-orders-blue", "orderId"),
        table("OrdersProd", "prod-orders-{Colour}", "orderId"),
        listing("prod-orders-blue", "customerId"),
      ],
      undefined,
      compared,
    );

    expect(compared).toEqual([]);
    expect(findings.map((f) => f.kind)).toEqual(["ambiguousProvider"]);
    const [ambiguous] = findings;
    expect(ambiguous?.severity).toBe("warning");
    expect(ambiguous?.description).toContain("prod-orders-blue");
    expect(ambiguous?.description).toContain("{StageName}-orders-blue");
    expect(ambiguous?.description).toContain("prod-orders-{Colour}");
  });

  it("still pairs with both when the two are one table spelled two ways", () => {
    const compared: ComparedPair[] = [];
    checkStorage(
      [
        table("OrdersBlue", "{StageName}-orders-blue", "orderId"),
        table("OrdersToo", "{Env}-orders-blue", "orderId"),
        listing("prod-orders-blue", "orderId"),
      ],
      undefined,
      compared,
    );

    expect(compared.map((pair) => pair.key).sort()).toEqual([
      "aws.dynamodb:OrdersBlue",
      "aws.dynamodb:OrdersToo",
    ]);
  });
});

describe("what storage pairing takes for granted", () => {
  it("reads a summary that states no workspace as a single-project run", () => {
    const declaring = {
      ...makeProvider({ container: "users", fields: [{ name: "id" }] }),
      location: {
        file: "billing/schema.prisma",
        range: { start: 1, end: 10 },
        exportName: null,
        workspace: "billing",
      },
    };
    const querying = makeAccessSummary({
      name: "readProfile",
      file: "shared/src/handler.ts",
      accesses: [{ container: "users", kind: "read", fields: ["email"] }],
    });

    const unknown = checkStorage([declaring, querying]).filter(
      (f) => f.kind === "boundaryFieldUnknown",
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.description).toContain("email");
  });

  it("compares the name a query selects against the name the schema declares, letter for letter", () => {
    const unknown = checkStorage([
      makeProvider({ container: "users", fields: [{ name: "created_at" }] }),
      makeAccessSummary({
        name: "listUsers",
        file: "src/listUsers.ts",
        accesses: [{ container: "users", kind: "read", fields: ["createdAt"] }],
      }),
    ]).filter((f) => f.kind === "boundaryFieldUnknown");

    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.severity).toBe("error");
    expect(unknown[0]?.description).toContain("createdAt");
  });

  it("reads any secondary access path as one that copies part of an item", () => {
    const unknown = checkStorage([
      makeProvider({
        container: "users",
        storageSystem: "postgresql",
        accessPath: "users_by_email_idx",
        fields: [{ name: "email" }],
      }),
      makeAccessSummary({
        name: "findByEmail",
        file: "src/findByEmail.ts",
        accesses: [
          {
            container: "users",
            storageSystem: "postgresql",
            accessPath: "users_by_email_idx",
            kind: "read",
            fields: ["*"],
          },
        ],
      }),
    ]).filter((f) => f.kind === "boundaryFieldUnknown");

    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.severity).toBe("error");
  });

  it("says a store refuses a selector that is not a key, whichever store it is", () => {
    const mismatch = checkStorage([
      makeProvider({
        container: "users",
        storageSystem: "postgresql",
        keyFields: ["id"],
        fields: [{ name: "id" }, { name: "email" }],
      }),
      makeAccessSummary({
        name: "findByEmail",
        file: "src/findByEmail.ts",
        accesses: [
          {
            container: "users",
            storageSystem: "postgresql",
            kind: "read",
            fields: ["id"],
            selector: ["email"],
          },
        ],
      }),
    ]).filter((f) => f.kind === "boundarySelectorMismatch");

    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]?.severity).toBe("error");
    expect(mismatch[0]?.description).toContain("postgresql");
  });
});
