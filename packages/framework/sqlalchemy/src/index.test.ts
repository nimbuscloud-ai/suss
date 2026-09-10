import { describe, expect, it } from "vitest";

import {
  sqlalchemyFramework,
  sqlalchemyModels,
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
    const patterns = sqlalchemyStorage({ storageSystem: "postgresql" });
    expect(patterns.flatMap((pattern) => pattern.queryTypes)).toContain(
      "Query",
    );
    expect(patterns.every((p) => p.storageSystem === "postgresql")).toBe(true);
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
          storageSystem: "postgresql",
        },
      ],
    };
    expect(
      withSqlalchemy(already, { storageSystem: "postgresql" }).storage,
    ).toHaveLength(3);
  });

  it("stands alone for a run that wants no routes", () => {
    const pack = sqlalchemyFramework({ storageSystem: "postgresql" });
    expect(pack.discovery).toEqual([]);
    expect(pack.storage).toHaveLength(2);
  });

  it("says which names a mapped class's ancestry arrives at", () => {
    const [model] = sqlalchemyModels();
    expect(model?.baseNames).toContain("DeclarativeBase");
    expect(model?.baseNames).toContain("declarative_base");
  });

  it("says which calls take the mapped class and give back one of it", () => {
    const [model] = sqlalchemyModels();
    expect(model?.entryMethods).toContainEqual({ method: "get", argument: 0 });
    expect(model?.entryMethods).toContainEqual({
      method: "query",
      argument: 0,
    });
    expect(model?.entryFunctions).toContainEqual({
      module: "sqlalchemy",
      name: "select",
      argument: 0,
    });
  });

  it("says which chain methods hand the same model on", () => {
    const [model] = sqlalchemyModels();
    expect(model?.givesBack).toContain("where");
    expect(model?.givesBack).toContain("first");
    expect(model?.givesBack).not.toContain("count");
  });

  it("carries the model declarations onto a route pack it composes with", () => {
    expect(
      withSqlalchemy(routePack, { storageSystem: "sqlite" }).models,
    ).toHaveLength(1);
  });
});

describe("a config that says no database", () => {
  it("refuses with a sentence instead of a TypeError", () => {
    expect(() => sqlalchemyFramework(undefined as never)).toThrow(
      /storageSystem/,
    );
  });
});
