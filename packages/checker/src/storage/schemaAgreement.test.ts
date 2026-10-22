import { describe, expect, it } from "vitest";

import { storageBinding } from "@suss/behavioral-ir";

import { checkSchemaAgreement } from "./schemaAgreement.js";

import type {
  BehavioralSummary,
  Finding,
  StorageContractMetadata,
} from "@suss/behavioral-ir";
import type { ComparedPair } from "../pairing/comparedPair.js";

type Field = NonNullable<StorageContractMetadata["fields"]>[number];

function table(opts: {
  file: string;
  container: string | null;
  fields: Field[];
  physicalTable?: string;
  storageSystem?: string | null;
  scope?: string;
  accessPath?: string | null;
  workspace?: string;
  fieldSet?: "exhaustive" | "partial" | "none";
  origin?: "dump" | "migrations";
  source?: boolean;
}): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: opts.file,
      range: { start: 1, end: 1 },
      exportName: null,
      ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
    },
    identity: {
      name: opts.container ?? "<unnamed>",
      exportPath: null,
      boundaryBinding: storageBinding({
        recognition: "test",
        storageSystem:
          opts.storageSystem === undefined ? "postgresql" : opts.storageSystem,
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
        ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
        ...(opts.source !== undefined ? { source: opts.source } : {}),
      },
    },
  };
}

const ID_UUID: Field = {
  name: "id",
  type: "uuid",
  primary: true,
  nullable: false,
  default: true,
};

/** A Rails dump of one table, keyed on a uuid `id`. */
function dump(fields: Field[], container = "orders"): BehavioralSummary {
  return table({
    file: "db/schema.rb",
    container,
    origin: "dump",
    fields: [ID_UUID, ...fields],
  });
}

/** A Drizzle copy of the same table. */
function copy(fields: Field[], container = "orders"): BehavioralSummary {
  return table({
    file: "src/db/schema.ts",
    container,
    fields: [ID_UUID, ...fields],
  });
}

function check(...summaries: BehavioralSummary[]) {
  return checkSchemaAgreement(summaries);
}

function described(findings: Finding[]) {
  return findings.map((f) => ({
    kind: f.kind,
    severity: f.severity,
    description: f.description,
  }));
}

describe("checkSchemaAgreement: the headline case", () => {
  const rails = table({
    file: "db/schema.rb",
    container: "attachments",
    origin: "dump",
    fields: [
      ID_UUID,
      { name: "blob_id", type: "uuid", nullable: false, default: false },
      { name: "created_at", type: "datetime", nullable: false, default: false },
    ],
  });
  const drizzle = table({
    file: "src/db/schema.ts",
    container: "attachments",
    fields: [
      ID_UUID,
      {
        name: "blobId",
        column: "blob_id",
        type: "bigint",
        nullable: false,
        default: false,
      },
      {
        name: "createdAt",
        column: "created_at",
        type: "timestamp",
        nullable: false,
        default: true,
      },
    ],
  });

  it("reports uuid against bigint and a copy's default on a NOT NULL column, both at error", () => {
    const { findings } = check(drizzle, rails);
    expect(described(findings)).toEqual([
      {
        kind: "boundaryShapeMismatch",
        severity: "error",
        description:
          "attachments.blob_id: db/schema.rb declares uuid and src/db/schema.ts declares bigint. The database contains uuid values the copy cannot read, and refuses the bigint it writes.",
      },
      {
        kind: "boundaryShapeMismatch",
        severity: "error",
        description:
          "attachments.created_at: src/db/schema.ts declares a database default and db/schema.rb declares none on a NOT NULL column. An insert through the copy that leaves it out is refused.",
      },
    ]);
  });

  it("puts the dump on the provider side and gives each side its own spelling of the field", () => {
    const [blob] = check(drizzle, rails).findings;
    expect(blob?.provider).toMatchObject({
      summary: "db/schema.rb::attachments",
      field: "blob_id",
    });
    expect(blob?.consumer).toMatchObject({
      summary: "src/db/schema.ts::attachments",
      field: "blobId",
    });
    expect(blob?.boundary).toBe(rails.identity.boundaryBinding);
  });

  it("records the two declarations as a compared pair", () => {
    const compared: ComparedPair[] = [];
    checkSchemaAgreement([drizzle, rails], undefined, compared);
    expect(compared).toEqual([
      {
        key: "postgresql:attachments",
        provider: "db/schema.rb::attachments",
        consumer: "src/db/schema.ts::attachments",
      },
    ]);
  });
});

describe("checkSchemaAgreement: which declarations are one table", () => {
  const blobUuid: Field = { name: "blob_id", type: "uuid" };
  const blobBigint: Field = { name: "blob_id", type: "bigint" };

  it("pairs a model with a table through the physical name", () => {
    const prisma = table({
      file: "prisma/schema.prisma",
      container: "Order",
      physicalTable: "orders",
      fields: [ID_UUID, blobBigint],
    });
    expect(check(dump([blobUuid]), prisma).findings).toHaveLength(1);
  });

  it("leaves a model without a physical name apart from the table, since Postgres keeps the two apart", () => {
    const prisma = table({
      file: "prisma/schema.prisma",
      container: "Order",
      fields: [ID_UUID, blobBigint],
    });
    expect(check(dump([blobUuid]), prisma).findings).toEqual([]);
  });

  it("lets a store with no engine meet one on any engine", () => {
    const unknownEngine = table({
      file: "src/db/schema.ts",
      container: "orders",
      storageSystem: null,
      fields: [ID_UUID, blobBigint],
    });
    expect(check(dump([blobUuid]), unknownEngine).findings).toHaveLength(1);
  });

  it("keeps two engines apart", () => {
    const mysql = table({
      file: "src/db/schema.ts",
      container: "orders",
      storageSystem: "mysql",
      fields: [ID_UUID, blobBigint],
    });
    expect(check(dump([blobUuid]), mysql).findings).toEqual([]);
  });

  it("keeps two scopes apart", () => {
    const other = table({
      file: "src/db/schema.ts",
      container: "orders",
      scope: "analytics",
      fields: [ID_UUID, blobBigint],
    });
    expect(check(dump([blobUuid]), other).findings).toEqual([]);
  });

  it("keeps two access paths apart", () => {
    const index = table({
      file: "src/db/schema.ts",
      container: "orders",
      accessPath: "by_customer",
      fields: [ID_UUID, blobBigint],
    });
    expect(check(dump([blobUuid]), index).findings).toEqual([]);
  });

  it("keeps two workspaces apart, and pairs a declaration with no workspace with either", () => {
    const inWorkspace = (workspace: string, fields: Field[]) =>
      table({
        file: `${workspace}/src/schema.ts`,
        container: "orders",
        workspace,
        fields: [ID_UUID, ...fields],
      });
    expect(
      check(
        inWorkspace("billing", [blobUuid]),
        inWorkspace("web", [blobBigint]),
      ).findings,
    ).toEqual([]);
    expect(
      check(dump([blobUuid]), inWorkspace("web", [blobBigint])).findings,
    ).toHaveLength(1);
  });

  it("compares nothing on SQLite, which stores by affinity", () => {
    const onSqlite = (file: string, fields: Field[]) =>
      table({
        file,
        container: "orders",
        storageSystem: "sqlite",
        fields: [ID_UUID, ...fields],
      });
    expect(
      check(onSqlite("a.prisma", [blobUuid]), onSqlite("b.ts", [blobBigint]))
        .findings,
    ).toEqual([]);
  });

  it("compares nothing against a declaration that does not list every column", () => {
    const partial = table({
      file: "template.yaml",
      container: "orders",
      fieldSet: "partial",
      fields: [ID_UUID, blobBigint],
    });
    expect(check(dump([blobUuid]), partial).findings).toEqual([]);
  });
});

describe("checkSchemaAgreement: which columns are compared", () => {
  it("compares the column a field is stored under, not the name the code uses", () => {
    const findings = check(
      dump([{ name: "blob_id", type: "uuid", nullable: false }]),
      copy([
        { name: "blobId", column: "blob_id", type: "uuid", nullable: false },
      ]),
    ).findings;
    expect(findings).toEqual([]);
  });

  it("skips a derived field, which no table stores", () => {
    const findings = check(
      dump([]),
      copy([{ name: "customer", type: "Customer", derived: true }]),
    ).findings;
    expect(findings).toEqual([]);
  });

  it("lists a column whose type has no family as unchecked, with the reason", () => {
    const result = check(
      dump([{ name: "payload", type: "jsonb" }]),
      copy([{ name: "payload", type: "customType" }]),
    );
    expect(result.findings).toEqual([]);
    expect(result.unchecked).toEqual([
      {
        boundary: "postgresql:orders",
        provider: "db/schema.rb::orders",
        consumer: "src/db/schema.ts::orders",
        column: "payload",
        reason:
          "src/db/schema.ts declares customType, which suss has no type family for",
      },
    ]);
  });
});

describe("checkSchemaAgreement: type families", () => {
  const agreeing: Array<[string, string]> = [
    ["integer", "Int"],
    ["serial", "Integer"],
    ["smallint", "@db.SmallInt"],
    ["smallserial", "SmallInteger"],
    ["bigint", "BigInt"],
    ["bigserial", "BigInteger"],
    ["decimal", "Numeric"],
    ["numeric", "Decimal"],
    ["float", "doublePrecision"],
    ["real", "Float"],
    ["string", "varchar"],
    ["citext", "@db.Text"],
    ["text", "String"],
    ["char", "@db.VarChar"],
    ["boolean", "Boolean"],
    ["tinyint(1)", "boolean"],
    ["uuid", "@db.Uuid"],
    ["Uuid", "uuid"],
    ["datetime", "timestamp"],
    ["timestamptz", "DateTime"],
    ["@db.Timestamptz", "datetime"],
    ["json", "jsonb"],
    ["Json", "@db.JsonB"],
    ["JSON", "JSONB"],
    ["binary", "bytea"],
    ["Bytes", "LargeBinary"],
    ["enum", "Enum"],
    ["string[]", "ARRAY"],
    ["integer[]", "String[]"],
    ["date", "date"],
    ["time", "time"],
    ["interval", "interval"],
    ["integer", "@db.Integer"],
    ["integer", "@db.Int"],
    ["float", "@db.Double"],
    ["float", "@db.Float"],
    ["text", "@db.TinyText"],
    ["text", "@db.MediumText"],
    ["text", "@db.LongText"],
    ["boolean", "@db.Boolean"],
    ["datetime", "@db.DateTime"],
    ["binary", "@db.Binary"],
    ["binary", "@db.VarBinary"],
    ["binary", "@db.TinyBlob"],
    ["binary", "@db.Blob"],
    ["binary", "@db.MediumBlob"],
    ["binary", "@db.LongBlob"],
  ];

  it.each(agreeing)("treats %s and %s as one family", (left, right) => {
    const result = check(
      dump([{ name: "value", type: left }]),
      copy([{ name: "value", type: right }]),
    );
    expect(result.findings).toEqual([]);
    expect(result.unchecked).toEqual([]);
  });

  const differing: Array<[string, string]> = [
    ["uuid", "bigint"],
    ["integer", "bigint"],
    ["smallint", "integer"],
    ["string", "integer"],
    ["json", "text"],
    ["date", "timestamp"],
    ["time", "timestamp"],
    ["boolean", "integer"],
    ["numeric", "float"],
  ];

  it.each(differing)("reports %s against %s", (left, right) => {
    const [finding] = check(
      dump([{ name: "value", type: left }]),
      copy([{ name: "value", type: right }]),
    ).findings;
    expect(finding?.kind).toBe("boundaryShapeMismatch");
    expect(finding?.severity).toBe("error");
  });
});

describe("checkSchemaAgreement: nullability", () => {
  it("reports a copy that can write NULL into a NOT NULL column", () => {
    expect(
      described(
        check(
          dump([{ name: "total", type: "integer", nullable: false }]),
          copy([{ name: "total", type: "integer", nullable: true }]),
        ).findings,
      ),
    ).toEqual([
      {
        kind: "boundaryShapeMismatch",
        severity: "error",
        description:
          "orders.total: db/schema.rb declares it NOT NULL and src/db/schema.ts declares it nullable. The copy can write NULL there, and the database refuses it.",
      },
    ]);
  });

  it("reports a copy that does not expect the NULLs the database returns", () => {
    expect(
      described(
        check(
          dump([{ name: "total", type: "integer", nullable: true }]),
          copy([{ name: "total", type: "integer", nullable: false }]),
        ).findings,
      ),
    ).toEqual([
      {
        kind: "boundaryShapeMismatch",
        severity: "error",
        description:
          "orders.total: db/schema.rb declares it nullable and src/db/schema.ts declares it NOT NULL. The database can return NULL there, and the copy does not expect it.",
      },
    ]);
  });

  it("compares nothing when one side does not say", () => {
    expect(
      check(
        dump([{ name: "total", type: "integer", nullable: false }]),
        copy([{ name: "total", type: "integer" }]),
      ).findings,
    ).toEqual([]);
  });
});

describe("checkSchemaAgreement: database defaults", () => {
  it("warns about a copy's default on a nullable column, which stores NULL silently", () => {
    expect(
      described(
        check(
          dump([
            { name: "note", type: "text", nullable: true, default: false },
          ]),
          copy([{ name: "note", type: "text", nullable: true, default: true }]),
        ).findings,
      ),
    ).toEqual([
      {
        kind: "boundaryShapeMismatch",
        severity: "warning",
        description:
          "orders.note: src/db/schema.ts declares a database default and db/schema.rb declares none on a nullable column. An insert through the copy that leaves it out stores NULL, and nothing says so.",
      },
    ]);
  });

  it("says nothing about a database default the copy lacks, since the copy supplies a value every time", () => {
    expect(
      check(
        dump([{ name: "state", type: "text", nullable: false, default: true }]),
        copy([
          { name: "state", type: "text", nullable: false, default: false },
        ]),
      ).findings,
    ).toEqual([]);
  });

  it("compares nothing when one reader does not read defaults", () => {
    expect(
      check(
        dump([
          { name: "state", type: "text", nullable: false, default: false },
        ]),
        copy([{ name: "state", type: "text", nullable: false }]),
      ).findings,
    ).toEqual([]);
  });
});

describe("checkSchemaAgreement: a column on one side only", () => {
  it("reports a column the copy declares and the database lacks", () => {
    const [finding] = check(
      dump([]),
      copy([{ name: "productType", column: "producttype", type: "text" }]),
    ).findings;
    expect(finding).toMatchObject({
      kind: "boundaryFieldUnknown",
      severity: "error",
      description:
        "orders.producttype: src/db/schema.ts declares the column and db/schema.rb has no such column. Every query through the copy that selects it fails.",
      consumer: { field: "productType" },
    });
    expect(finding?.provider.field).toBeUndefined();
  });

  it("reports a NOT NULL column with no default that the copy leaves out", () => {
    const [finding] = check(
      dump([
        { name: "tenant_id", type: "uuid", nullable: false, default: false },
      ]),
      copy([]),
    ).findings;
    expect(finding).toMatchObject({
      kind: "boundaryFieldUnknown",
      severity: "error",
      description:
        "orders.tenant_id: db/schema.rb declares it NOT NULL with no default, and src/db/schema.ts leaves it out. The copy cannot supply it, so the database refuses every insert through the copy.",
      provider: { field: "tenant_id" },
    });
    expect(finding?.consumer.field).toBeUndefined();
  });

  it("leaves out a nullable or defaulted column the copy omits, as a partial copy is meant to", () => {
    expect(
      check(
        dump([
          { name: "note", type: "text", nullable: true, default: false },
          { name: "state", type: "text", nullable: false, default: true },
        ]),
        copy([]),
      ).findings,
    ).toEqual([]);
  });
});

describe("checkSchemaAgreement: foreign keys", () => {
  const customers = table({
    file: "prisma/schema.prisma",
    container: "Customer",
    physicalTable: "customers",
    fields: [ID_UUID],
  });

  it("warns when the two point a column at different tables", () => {
    expect(
      described(
        check(
          dump([
            { name: "customer_id", type: "uuid", foreignKey: "customers" },
          ]),
          copy([{ name: "customer_id", type: "uuid", foreignKey: "accounts" }]),
        ).findings,
      ),
    ).toEqual([
      {
        kind: "boundaryShapeMismatch",
        severity: "warning",
        description:
          "orders.customer_id: db/schema.rb points it at customers and src/db/schema.ts points it at accounts. A join written against the copy reaches a different table from the one the database links it to.",
      },
    ]);
  });

  it("reads a model name and its physical name as one target", () => {
    expect(
      check(
        customers,
        dump([{ name: "customer_id", type: "uuid", foreignKey: "customers" }]),
        copy([{ name: "customer_id", type: "uuid", foreignKey: "Customer" }]),
      ).findings,
    ).toEqual([]);
  });

  it("compares nothing when only one side states a key", () => {
    expect(
      check(
        dump([{ name: "customer_id", type: "uuid", foreignKey: "customers" }]),
        copy([{ name: "customer_id", type: "uuid" }]),
      ).findings,
    ).toEqual([]);
  });
});

describe("checkSchemaAgreement: the primary key guard", () => {
  it("gives one warning in place of every column finding when the keys differ by family", () => {
    const authUsers = table({
      file: "prisma/schema.prisma",
      container: "users",
      fields: [
        { name: "id", type: "String", primary: true, nullable: false },
        { name: "email", type: "String", nullable: true },
      ],
    });
    const railsUsers = table({
      file: "db/schema.rb",
      container: "users",
      origin: "dump",
      fields: [
        ID_UUID,
        { name: "email", type: "string", nullable: false, default: false },
        { name: "admin", type: "boolean", nullable: false, default: false },
      ],
    });
    expect(described(check(railsUsers, authUsers).findings)).toEqual([
      {
        kind: "boundaryShapeMismatch",
        severity: "warning",
        description:
          "users: db/schema.rb keys it on id (uuid) and prisma/schema.prisma keys it on id (String). These may be two databases that each have a table of this name, so no column was compared. If they are, give each its own scope.",
      },
    ]);
  });

  it("gives the same warning when the keys are different columns", () => {
    const findings = check(
      dump([{ name: "total", type: "integer" }]),
      table({
        file: "src/db/schema.ts",
        container: "orders",
        fields: [
          { name: "code", type: "text", primary: true },
          { name: "total", type: "text" },
        ],
      }),
    ).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]?.description).toContain("keys it on code (text)");
    expect(findings[0]?.provider.field).toBeUndefined();
  });

  it("lets a key type with no family agree with any", () => {
    const findings = check(
      dump([{ name: "total", type: "integer" }]),
      table({
        file: "src/db/schema.ts",
        container: "orders",
        fields: [
          { name: "id", type: "customType", primary: true },
          { name: "total", type: "bigint" },
        ],
      }),
    ).findings;
    expect(findings.map((f) => f.description)).toEqual([
      "orders.total: db/schema.rb declares integer and src/db/schema.ts declares bigint. The database contains integer values the copy cannot read, and refuses the bigint it writes.",
    ]);
  });

  it("leaves a table unchecked when one side declares no key", () => {
    const result = check(
      dump([{ name: "total", type: "integer" }]),
      table({
        file: "src/db/schema.ts",
        container: "orders",
        fields: [{ name: "total", type: "bigint" }],
      }),
    );
    expect(result.findings).toEqual([]);
    expect(result.unchecked).toEqual([
      expect.objectContaining({
        column: null,
        reason:
          "src/db/schema.ts declares no primary key, so nothing shows the two declarations are one table",
      }),
    ]);
  });
});

describe("checkSchemaAgreement: which side is the provider", () => {
  const sides = (findings: Finding[]) =>
    findings.map((f) => [f.provider.summary, f.consumer.summary]);

  const plain = (file: string, origin?: "dump" | "migrations") =>
    table({
      file,
      container: "orders",
      ...(origin !== undefined ? { origin } : {}),
      fields: [
        ID_UUID,
        { name: "total", type: file.endsWith("rb") ? "integer" : "bigint" },
      ],
    });

  it("makes the dump the provider whatever the paths sort as", () => {
    expect(
      sides(check(plain("a/schema.ts"), plain("z/schema.rb", "dump")).findings),
    ).toEqual([["z/schema.rb::orders", "a/schema.ts::orders"]]);
  });

  it("prefers a declaration with its own migrations to one without, and keeps the text symmetric", () => {
    const { findings } = check(
      plain("a/schema.ts"),
      plain("z/schema.rb", "migrations"),
    );
    expect(sides(findings)).toEqual([
      ["z/schema.rb::orders", "a/schema.ts::orders"],
    ]);
    expect(findings[0]?.description).toBe(
      "orders.total: z/schema.rb declares integer and a/schema.ts declares bigint. Whichever one is wrong reads values it cannot parse and writes values the table refuses.",
    );
  });

  it("falls back on the path that sorts first", () => {
    expect(
      sides(check(plain("z/schema.ts"), plain("a/schema.rb")).findings),
    ).toEqual([["a/schema.rb::orders", "z/schema.ts::orders"]]);
  });

  it("lets a declaration the project marks as the source outrank a dump", () => {
    const marked = table({
      file: "src/db/schema.ts",
      container: "orders",
      source: true,
      fields: [ID_UUID, { name: "total", type: "bigint" }],
    });
    const { findings } = check(plain("db/schema.rb", "dump"), marked);
    expect(sides(findings)).toEqual([
      ["src/db/schema.ts::orders", "db/schema.rb::orders"],
    ]);
    expect(findings[0]?.description).toContain("The database contains bigint");
  });

  it("keeps two dumps symmetric, since either could be the stale one", () => {
    const { findings } = check(
      plain("db/structure.rb", "dump"),
      table({
        file: "db/schema.rb",
        container: "orders",
        origin: "dump",
        fields: [ID_UUID, { name: "note", type: "text" }],
      }),
    );
    expect(findings.map((f) => f.severity)).toEqual(["warning", "warning"]);
  });
});

describe("checkSchemaAgreement: no declaration known to match the database", () => {
  const prisma = (fields: Field[]) =>
    table({
      file: "prisma/schema.prisma",
      container: "orders",
      origin: "migrations",
      fields: [ID_UUID, ...fields],
    });

  it("warns about a column on one side only, in either direction", () => {
    expect(
      described(
        check(
          prisma([{ name: "note", type: "text", nullable: true }]),
          copy([{ name: "label", type: "text", nullable: true }]),
        ).findings,
      ),
    ).toEqual([
      {
        kind: "boundaryFieldUnknown",
        severity: "warning",
        description:
          "orders.note: prisma/schema.prisma declares the column and src/db/schema.ts does not. Neither one is known to match the database, so either could be out of date.",
      },
      {
        kind: "boundaryFieldUnknown",
        severity: "warning",
        description:
          "orders.label: src/db/schema.ts declares the column and prisma/schema.prisma does not. Neither one is known to match the database, so either could be out of date.",
      },
    ]);
  });

  it("warns about a default on one side only", () => {
    const [finding] = check(
      prisma([{ name: "createdAt", type: "DateTime", default: false }]),
      copy([{ name: "createdAt", type: "timestamp", default: true }]),
    ).findings;
    expect(finding).toMatchObject({
      kind: "boundaryShapeMismatch",
      severity: "warning",
      description:
        "orders.createdAt: src/db/schema.ts declares a database default and prisma/schema.prisma declares none. Neither one is known to match the database, so either could be out of date.",
    });
  });

  it("still reports nullability at error, with both readings", () => {
    const [finding] = check(
      prisma([{ name: "total", type: "Int", nullable: true }]),
      copy([{ name: "total", type: "integer", nullable: false }]),
    ).findings;
    expect(finding).toMatchObject({
      severity: "error",
      description:
        "orders.total: prisma/schema.prisma declares it nullable and src/db/schema.ts declares it NOT NULL. If the column is NOT NULL, prisma/schema.prisma writes NULLs the table refuses. If it is nullable, src/db/schema.ts reads NULLs it does not expect.",
    });
  });
});

describe("checkSchemaAgreement: three declarations of one table", () => {
  it("checks each copy against the dump and not against each other", () => {
    const drizzle = copy([{ name: "total", type: "bigint" }]);
    const prisma = table({
      file: "prisma/schema.prisma",
      container: "orders",
      fields: [ID_UUID, { name: "total", type: "Int" }],
    });
    const compared: ComparedPair[] = [];
    const { findings } = checkSchemaAgreement(
      [drizzle, prisma, dump([{ name: "total", type: "integer" }])],
      undefined,
      compared,
    );
    expect(compared.map((pair) => [pair.provider, pair.consumer])).toEqual([
      ["db/schema.rb::orders", "src/db/schema.ts::orders"],
      ["db/schema.rb::orders", "prisma/schema.prisma::orders"],
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.consumer.summary).toBe("src/db/schema.ts::orders");
  });
});
