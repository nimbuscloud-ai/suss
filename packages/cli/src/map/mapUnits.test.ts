import { describe, expect, it } from "vitest";

import {
  envRead,
  modelOf,
  resolver,
  rest,
  transition,
  unit,
} from "../__fixtures__/mapSummaries.js";
import { pageDataOf } from "./mapPageData.js";
import { specDocumentPath } from "./mapUnits.js";

describe("specDocumentPath", () => {
  it.each([
    ["openapi:api/openapi.yaml", "api/openapi.yaml"],
    ["api/schema.graphql:Query.note", "api/schema.graphql"],
    ["cloudformation:infra/template.yaml::Checkout", "infra/template.yaml"],
  ])("gives the file %s was read from", (label, file) => {
    expect(specDocumentPath(label)).toBe(file);
  });

  it.each([
    ["cloudformation:template.yaml#ApiStack::Ping"],
    ["openapi:https://example.com/openapi.yaml"],
    ["openapi"],
  ])("gives no file for %s", (label) => {
    expect(specDocumentPath(label)).toBeNull();
  });
});

describe("the units a spec declares", () => {
  it("point at the spec file and the line the reader recorded", () => {
    const declared = unit({
      kind: "handler",
      file: "openapi:api/openapi.yaml",
      name: "deleteNote",
      line: 13,
      binding: rest("DELETE", "/notes/{id}"),
      noId: true,
    });

    const model = modelOf([], [declared]);
    const found = model.units.find((u) => u.name === "deleteNote");

    expect(found).toMatchObject({
      spec: true,
      document: "api/openapi.yaml",
      line: 13,
    });
    const at = model.units.indexOf(found as (typeof model.units)[number]);
    expect(pageDataOf(model).data.u[at]?.[8]).not.toBeNull();
  });
});

describe("a config file the app renders when it boots", () => {
  const databaseYml = unit({
    kind: "module-init",
    file: "config/database.yml",
    name: "database.yml",
    transitions: [
      transition("database.yml:load", {
        effects: [envRead("DATABASE_URL", false)],
      }),
    ],
  });

  it("is code when an extract read it, so its environment reads show", () => {
    const model = modelOf([databaseYml]);

    expect(model.envReads).toHaveLength(1);
    const reader = model.units[model.envReads[0]?.unit ?? -1];
    expect(reader).toMatchObject({ file: "config/database.yml", spec: false });
  });

  it("is marked on the page as read at boot", () => {
    const model = modelOf([databaseYml]);
    const at = model.envReads[0]?.unit ?? -1;

    expect(pageDataOf(model).data.u[at]?.[9]).toBe(1);
  });
});

describe("the GraphQL types a schema declares without fields", () => {
  it("lists its enums, unions and custom scalars", () => {
    const schema = unit({
      kind: "resolver",
      file: "schema.graphql:Query.search",
      name: "Query.search",
      binding: resolver("Query", "search", "graphql"),
      noId: true,
      metadata: {
        sourceDocument: { label: "schema.graphql" },
        graphql: {
          schemaSdl: [
            "scalar DateTime",
            "enum Status { ACTIVE ARCHIVED }",
            "union SearchResult = Note | Folder",
            "type Note { id: ID! }",
            "type Folder { id: ID! }",
            "type Query { search: [SearchResult!]! }",
          ].join("\n"),
        },
      },
    });

    const model = modelOf([], [schema]);
    const byName = new Map(model.graphqlTypes.map((t) => [t.name, t]));

    expect(byName.get("Status")).toMatchObject({
      kind: "enum",
      members: ["ACTIVE", "ARCHIVED"],
    });
    expect(byName.get("SearchResult")).toMatchObject({
      kind: "union",
      members: ["Note", "Folder"],
    });
    expect(byName.get("DateTime")).toMatchObject({ kind: "scalar" });
    expect(pageDataOf(model).data.ty.some((t) => t[2] === "enum")).toBe(true);
  });
});
