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

  it("pairs an access that spells a name the template builds at deploy time", () => {
    // Nothing reports the read field, since a table's contract is
    // partial. The two sides meeting shows in the declared key being
    // read rather than sitting unused.
    const findings = checkStorage([
      makeProvider({
        container: "OrdersTable",
        storageSystem: "dynamodb",
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
            storageSystem: "dynamodb",
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
        storageSystem: "dynamodb",
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
            storageSystem: "dynamodb",
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
        storageSystem: "dynamodb",
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
            storageSystem: "dynamodb",
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
        storageSystem: "dynamodb",
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
            storageSystem: "dynamodb",
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
});

describe("an index that copies part of an item", () => {
  /** What terraform says an INCLUDE index can serve. */
  function narrowIndex(): BehavioralSummary {
    return makeProvider({
      container: "editions-v2",
      storageSystem: "dynamodb",
      accessPath: "by-publication-v2",
      fieldSet: "exhaustive",
      keyFields: ["publication_id", "created_at"],
      fields: [
        { name: "publication_id" },
        { name: "created_at" },
        { name: "edition_id" },
        { name: "status" },
        { name: "web_content_title" },
      ],
    });
  }

  it("reports a query that reads a field the index does not copy", () => {
    const feed = makeAccessSummary({
      name: "readerFeed",
      file: "src/feed.ts",
      accesses: [
        {
          container: "editions-v2",
          storageSystem: "dynamodb",
          accessPath: "by-publication-v2",
          kind: "read",
          fields: ["status", "web_content_title", "published_article_id"],
          selector: ["publication_id"],
        },
      ],
    });
    const findings = checkStorage([narrowIndex(), feed]).filter(
      (f) => f.kind === "boundaryFieldUnknown",
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.description).toContain("published_article_id");
  });

  it("says nothing when the query reads only what the index copies", () => {
    const feed = makeAccessSummary({
      name: "readerFeed",
      file: "src/feed.ts",
      accesses: [
        {
          container: "editions-v2",
          storageSystem: "dynamodb",
          accessPath: "by-publication-v2",
          kind: "read",
          fields: ["status", "web_content_title"],
          selector: ["publication_id"],
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
      container: "editions-v2",
      storageSystem: "dynamodb",
      fieldSet: "partial",
      keyFields: ["edition_id", "created_at"],
      fields: [{ name: "edition_id" }, { name: "created_at" }],
    });
    const byId = makeAccessSummary({
      name: "readEdition",
      file: "src/edition.ts",
      accesses: [
        {
          container: "editions-v2",
          storageSystem: "dynamodb",
          kind: "read",
          fields: ["published_article_id"],
          selector: ["edition_id"],
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
      container: "editions-v2",
      storageSystem: "dynamodb",
      accessPath: "by-publication-v2",
      fieldSet: "exhaustive",
      keyFields: ["publication_id"],
      fields: [{ name: "publication_id" }, { name: "status" }],
    });
    const feed = makeAccessSummary({
      name: "readerFeed",
      file: "src/feed.ts",
      accesses: [
        {
          container: "editions-v2",
          storageSystem: "dynamodb",
          accessPath: "by-publication-v2",
          kind: "read",
          fields: ["*"],
          selector: ["publication_id"],
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
