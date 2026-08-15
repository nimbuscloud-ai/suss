import { describe, expect, it } from "vitest";

import {
  activeRecordFramework,
  activeRecordStorage,
  withActiveRecord,
} from "./index.js";

import type { RubyPack } from "@suss/adapter-ruby";

const graphqlPack: RubyPack = {
  name: "graphql-ruby",
  protocol: "http-graphql",
  discovery: [],
};

describe("the ActiveRecord pack", () => {
  it("says which base class the library gives a model", () => {
    const [pattern] = activeRecordStorage({ storageSystem: "postgres" });
    expect(pattern?.baseClasses).toEqual(["ActiveRecord::Base"]);
    expect(pattern?.writes).toContain("destroy");
    expect(pattern?.writes).toContain("save!");
  });

  it("takes the database from the caller, since ActiveRecord talks to all of them", () => {
    const [pattern] = activeRecordStorage({ storageSystem: "mysql" });
    expect(pattern?.storageSystem).toBe("mysql");
  });

  it("adds itself to a pack without disturbing its discovery", () => {
    const composed = withActiveRecord(graphqlPack, {
      storageSystem: "sqlite",
    });
    expect(composed.name).toBe("graphql-ruby");
    expect(composed.discovery).toBe(graphqlPack.discovery);
    expect(composed.storage).toHaveLength(1);
  });

  it("keeps a storage pattern the pack already had", () => {
    const already: RubyPack = {
      ...graphqlPack,
      storage: [
        { baseClasses: ["Other::Base"], writes: [], storageSystem: "postgres" },
      ],
    };
    expect(
      withActiveRecord(already, { storageSystem: "postgres" }).storage,
    ).toHaveLength(2);
  });

  it("stands alone for a run that wants no discovery", () => {
    const pack = activeRecordFramework({ storageSystem: "postgres" });
    expect(pack.discovery).toEqual([]);
    expect(pack.storage).toHaveLength(1);
  });
});

describe("a config that says no database", () => {
  it("refuses with a sentence instead of a TypeError", () => {
    expect(() => activeRecordFramework(undefined as never)).toThrow(
      /storageSystem/,
    );
  });
});
