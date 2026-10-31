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

import type { Effect } from "@suss/behavioral-ir";

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

describe("a repository method every model shares", () => {
  const sharedRead: Effect = {
    type: "interaction",
    binding: {
      transport: "postgresql",
      semantics: {
        name: "storage",
        storageSystem: "postgresql",
        scope: "default",
        container: null,
        accessPath: null,
      },
      recognition: "sqlalchemy",
    },
    callee: "select(self.model)",
    containerByConstruction: {
      "app/main.py:3:5": "tools",
      "app/main.py:9:5": "tags",
    },
    interaction: { class: "storage-access", kind: "read", fields: ["*"] },
  };
  const getOne = unit({
    kind: "library",
    file: "app/repos.py",
    name: "Repository.get_one",
    line: 20,
    transitions: [transition("get_one:return", { effects: [sharedRead] })],
  });
  const route = (path: string, construction: string, line: number) =>
    unit({
      kind: "handler",
      file: "app/main.py",
      name: path.slice(1),
      line,
      binding: rest("GET", path),
      transitions: [
        transition(`${path}:200`, {
          status: 200,
          effects: [
            {
              type: "invocation",
              callee: "repo.get_one",
              summary: getOne.identity.id,
              args: [],
              async: false,
              receiverConstructions: [construction],
            },
          ],
        }),
      ],
    });

  it("is one unit on the page, reading each table a construction passes", () => {
    const model = modelOf([
      route("/tools", "app/main.py:3:5", 1),
      route("/tags", "app/main.py:9:5", 7),
      getOne,
    ]);
    const readersOf = (table: string) =>
      model.tables
        .filter((one) => model.boundaries[one.boundary]?.label === table)
        .flatMap((one) => one.readers.map((r) => model.units[r.unit]?.id));

    expect(
      model.units.filter((one) => one.name === "Repository.get_one"),
    ).toHaveLength(1);
    expect(readersOf("postgresql:tools")).toEqual([
      "app/repos.py::Repository.get_one",
    ]);
    expect(readersOf("postgresql:tags")).toEqual([
      "app/repos.py::Repository.get_one",
    ]);
  });
});
