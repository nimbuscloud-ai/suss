import { SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createStrictTestProject } from "@suss/test-project";

import { receiverTypeMatching } from "./receiverType.js";

import type { ReceiverTypeQuery } from "./receiverType.js";

const LIBRARY = `
export declare class Database {
  select(): unknown;
}
export declare class Ledger extends Database {}
export declare class Pool {}
export declare function connect(): Database & { $client: Pool };
`;

const fromLibrary: ReceiverTypeQuery = {
  declaredIn: (filePath) => filePath.includes("/node_modules/ledger-db/"),
};

/** What the helper says about `db` in `db.select()` in the fixture. */
function matchOf(source: string, query: ReceiverTypeQuery): string | null {
  const project = createStrictTestProject();
  project.createSourceFile(
    "/node_modules/ledger-db/package.json",
    JSON.stringify({ name: "ledger-db", types: "index.d.ts" }),
  );
  project.createSourceFile("/node_modules/ledger-db/index.d.ts", LIBRARY);
  const file = project.createSourceFile("/probe.ts", source);
  const call = file
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .find((candidate) => candidate.getText().endsWith(".select()"));
  const callee = call?.getExpressionIfKind(SyntaxKind.PropertyAccessExpression);
  if (callee === undefined) {
    throw new Error("the fixture calls no `.select()`");
  }
  return receiverTypeMatching(callee.getExpression(), query);
}

describe("receiverTypeMatching through the checker", () => {
  it("matches the library's class", () => {
    const source = `
      import { Database } from "ledger-db";
      declare const db: Database;
      db.select();
    `;
    expect(matchOf(source, fromLibrary)).toBe("Database");
  });

  it("looks through an intersection a factory returns", () => {
    const source = `
      import { connect } from "ledger-db";
      const db = connect();
      db.select();
    `;
    expect(matchOf(source, fromLibrary)).toBe("Database");
  });

  it("looks past undefined and null in a union", () => {
    const source = `
      import { Database } from "ledger-db";
      declare const db: Database | undefined | null;
      db!.select();
    `;
    expect(matchOf(source, fromLibrary)).toBe("Database");
  });

  it("looks through a project's alias of an optional intersection", () => {
    const source = `
      import { connect } from "ledger-db";
      type Db = ReturnType<typeof connect> | undefined;
      declare const db: Db;
      db?.select();
    `;
    expect(matchOf(source, fromLibrary)).toBe("Database");
  });

  it("follows a project's subclass to the library's base class", () => {
    const source = `
      import { Database } from "ledger-db";
      class ReportStore extends Database {}
      declare const db: ReportStore;
      db.select();
    `;
    expect(matchOf(source, fromLibrary)).toBe("Database");
  });

  it("follows a type parameter to its constraint", () => {
    const source = `
      import { Database } from "ledger-db";
      function run<T extends Database>(db: T) {
        db.select();
      }
    `;
    expect(matchOf(source, fromLibrary)).toBe("Database");
  });

  it("requires both the name and the declaring file when both are given", () => {
    const source = `
      import { Ledger } from "ledger-db";
      declare const db: Ledger;
      db.select();
    `;
    expect(matchOf(source, { ...fromLibrary, named: ["Ledger"] })).toBe(
      "Ledger",
    );
    expect(matchOf(source, { ...fromLibrary, named: ["Database"] })).toBe(
      "Database",
    );
    expect(matchOf(source, { ...fromLibrary, named: ["Pool"] })).toBeNull();
  });

  it("leaves a project's own type alone", () => {
    const source = `
      class Database { select(): unknown { return null; } }
      declare const db: Database & { tag: string };
      db.select();
    `;
    expect(matchOf(source, fromLibrary)).toBeNull();
  });
});

describe("receiverTypeMatching without the library's declarations", () => {
  const byName: ReceiverTypeQuery = { named: ["OrderStore"] };

  it("reads the name written on the declaration", () => {
    const source = `
      interface Env { ORDERS: OrderStore }
      declare const env: Env;
      env.ORDERS.select();
    `;
    expect(matchOf(source, byName)).toBe("OrderStore");
  });

  it("reads through a written union, intersection and local alias", () => {
    const source = `
      type Orders = (OrderStore & { region: string }) | undefined;
      interface Env { ORDERS: Orders }
      declare const env: Env;
      env.ORDERS!.select();
    `;
    expect(matchOf(source, byName)).toBe("OrderStore");
  });

  it("gives no answer to a query that asks where the type is declared", () => {
    const source = `
      interface Env { ORDERS: OrderStore }
      declare const env: Env;
      env.ORDERS.select();
    `;
    expect(matchOf(source, { ...byName, ...fromLibrary })).toBeNull();
  });
});
