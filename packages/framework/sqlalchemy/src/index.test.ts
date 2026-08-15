import { describe, expect, it } from "vitest";

import {
  sqlalchemyFramework,
  sqlalchemyStorage,
  withSqlalchemy,
} from "./index.js";

import type { PythonPack } from "@suss/adapter-python";

const routePack: PythonPack = {
  name: "flask-restx",
  protocol: "http",
  discovery: [],
};

describe("the SQLAlchemy pack", () => {
  it("says which types a query comes back as", () => {
    const patterns = sqlalchemyStorage({ storageSystem: "postgres" });
    expect(patterns.flatMap((pattern) => pattern.queryTypes)).toContain(
      "Query",
    );
    expect(patterns.every((p) => p.storageSystem === "postgres")).toBe(true);
  });

  it("takes the database from the caller, since SQLAlchemy talks to all of them", () => {
    const patterns = sqlalchemyStorage({ storageSystem: "mysql" });
    expect(patterns.every((p) => p.storageSystem === "mysql")).toBe(true);
  });

  it("adds itself to a route pack without disturbing its routes", () => {
    const composed = withSqlalchemy(routePack, { storageSystem: "sqlite" });
    expect(composed.name).toBe("flask-restx");
    expect(composed.discovery).toBe(routePack.discovery);
    expect(composed.storage).toHaveLength(2);
  });

  it("keeps a storage pattern the route pack already had", () => {
    const already: PythonPack = {
      ...routePack,
      storage: [
        {
          module: "other",
          queryTypes: ["Thing"],
          writes: [],
          storageSystem: "postgres",
        },
      ],
    };
    expect(
      withSqlalchemy(already, { storageSystem: "postgres" }).storage,
    ).toHaveLength(3);
  });

  it("stands alone for a run that wants no routes", () => {
    const pack = sqlalchemyFramework({ storageSystem: "postgres" });
    expect(pack.discovery).toEqual([]);
    expect(pack.storage).toHaveLength(2);
  });
});

describe("a config that says no database", () => {
  it("refuses with a sentence instead of a TypeError", () => {
    expect(() => sqlalchemyFramework(undefined as never)).toThrow(
      /storageSystem/,
    );
  });
});
