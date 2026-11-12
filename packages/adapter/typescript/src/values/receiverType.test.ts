import { SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { GLOBAL_MODULE } from "@suss/resolution";
import { createStrictTestProject } from "@suss/test-project";

import { receiverTypesOf, typedAsExported } from "./receiverType.js";

import type { Typed } from "@suss/extractor";
import type { ReceiverType } from "./receiverType.js";

const LIBRARY = `
export declare class Database {
  select(): unknown;
}
export declare class Ledger extends Database {}
export declare class Pool {}
export declare function connect(): Database & { $client: Pool };
`;

/** The types behind `db` in the fixture's `db.select()` call. */
function typesOf(source: string): ReceiverType[] {
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
  return receiverTypesOf(callee.getExpression());
}

/** The names of the types the library declares, in the order found. */
function libraryTypesOf(source: string): string[] {
  return typesOf(source)
    .filter((type) =>
      type.declaredIn.some((filePath) =>
        filePath.includes("/node_modules/ledger-db/"),
      ),
    )
    .map((type) => type.name);
}

describe("receiverTypesOf through the checker", () => {
  it("finds the library's class", () => {
    const source = `
      import { Database } from "ledger-db";
      declare const db: Database;
      db.select();
    `;
    expect(libraryTypesOf(source)).toEqual(["Database"]);
  });

  it("looks through an intersection a factory returns", () => {
    const source = `
      import { connect } from "ledger-db";
      const db = connect();
      db.select();
    `;
    expect(libraryTypesOf(source)).toContain("Database");
  });

  it("looks past undefined and null in a union", () => {
    const source = `
      import { Database } from "ledger-db";
      declare const db: Database | undefined | null;
      db!.select();
    `;
    expect(libraryTypesOf(source)).toEqual(["Database"]);
  });

  it("looks through a project's alias of an optional intersection", () => {
    const source = `
      import { connect } from "ledger-db";
      type Db = ReturnType<typeof connect> | undefined;
      declare const db: Db;
      db?.select();
    `;
    expect(libraryTypesOf(source)).toContain("Database");
  });

  it("follows a project's subclass to the library's base classes", () => {
    const source = `
      import { Ledger } from "ledger-db";
      class ReportStore extends Ledger {}
      declare const db: ReportStore;
      db.select();
    `;
    expect(typesOf(source)[0]?.name).toBe("ReportStore");
    expect(libraryTypesOf(source)).toEqual(["Ledger", "Database"]);
  });

  it("follows a type parameter to its constraint", () => {
    const source = `
      import { Database } from "ledger-db";
      function run<T extends Database>(db: T) {
        db.select();
      }
    `;
    expect(libraryTypesOf(source)).toEqual(["Database"]);
  });

  it("reports a project's own type as declared in the project", () => {
    const source = `
      class Database { select(): unknown { return null; } }
      declare const db: Database & { tag: string };
      db.select();
    `;
    expect(libraryTypesOf(source)).toEqual([]);
    expect(typesOf(source)).toContainEqual({
      name: "Database",
      declaredIn: ["/probe.ts"],
      extendsWritten: [],
    });
  });

  it("gives the base a project class is written as extending", () => {
    const source = `
      import { Client } from "not-installed";
      class Database extends Client {}
      declare const db: Database;
      db.select();
    `;
    const database = typesOf(source).find((type) => type.name === "Database");
    expect(database?.extendsWritten.map((base) => base.getText())).toEqual([
      "Client",
    ]);
  });
});

describe("receiverTypesOf without the library's declarations", () => {
  it("reads the name written on the declaration", () => {
    const source = `
      interface Env { ORDERS: OrderStore }
      declare const env: Env;
      env.ORDERS.select();
    `;
    expect(typesOf(source)).toEqual([
      { name: "OrderStore", declaredIn: [], extendsWritten: [] },
    ]);
  });

  it("reads through a written union, intersection and local alias", () => {
    const source = `
      type Orders = (OrderStore & { region: string }) | undefined;
      interface Env { ORDERS: Orders }
      declare const env: Env;
      env.ORDERS!.select();
    `;
    expect(typesOf(source).map((type) => type.name)).toEqual([
      "Orders",
      "OrderStore",
    ]);
  });

  it("finds nothing when no type is written", () => {
    const source = `
      declare const env: { ORDERS };
      env.ORDERS.select();
    `;
    expect(typesOf(source)).toEqual([]);
  });
});

describe("typedAsExported with a type the runtime declares", () => {
  const GLOBAL_KV: Typed = {
    origin: "typed",
    importedFrom: [GLOBAL_MODULE],
    named: ["KVNamespace"],
  };

  const WORKER = `
    type Sessions = KVNamespace & { readonly region: string };
    type MaybeArchive = R2Bucket | undefined;
    interface TaggedSessions extends KVNamespace { readonly tag: string }
    interface Env {
      PLAIN: KVNamespace;
      ALIASED: Sessions;
      OPTIONAL: KVNamespace | undefined;
      JOINED: KVNamespace & { readonly region: string };
      EXTENDED: TaggedSessions;
      ARCHIVE: MaybeArchive;
    }
    export async function fetch(env: Env) {
      await env.PLAIN.get("a");
      await env.ALIASED.get("b");
      await env.OPTIONAL?.get("c");
      await env.JOINED.get("d");
      await env.EXTENDED.get("e");
      await env.ARCHIVE?.get("f");
    }
  `;

  /** The receiver of each `.get` the origin takes, as written. */
  function receiversTaken(origin: Typed, declared: boolean): string[] {
    const project = createStrictTestProject();
    if (declared) {
      project.createSourceFile(
        "/workerConfiguration.d.ts",
        `declare interface KVNamespace { get(key: string): Promise<string | null> }
         declare interface R2Bucket { get(key: string): Promise<unknown> }`,
      );
    }
    const file = project.createSourceFile("/worker.ts", WORKER);
    return file
      .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
      .filter((read) => read.getName() === "get")
      .map((read) => read.getExpression())
      .filter((receiver) => typedAsExported(receiver, origin, undefined))
      .map((receiver) => receiver.getText());
  }

  it("reads a member's type through an alias, a union, an intersection and an extending interface", () => {
    expect(receiversTaken(GLOBAL_KV, true)).toEqual([
      "env.PLAIN",
      "env.ALIASED",
      "env.OPTIONAL",
      "env.JOINED",
      "env.EXTENDED",
    ]);
  });

  it("reads the names written when nothing declares the type", () => {
    expect(receiversTaken(GLOBAL_KV, false)).toEqual([
      "env.PLAIN",
      "env.ALIASED",
      "env.OPTIONAL",
      "env.JOINED",
    ]);
  });

  it("asks a module's type of the name the file imports it under", () => {
    const fromModule: Typed = { ...GLOBAL_KV, importedFrom: ["workers-kit"] };

    expect(receiversTaken(fromModule, true)).toEqual([]);
  });
});
