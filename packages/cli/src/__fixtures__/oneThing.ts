/**
 * A small world for the tests that ask about one thing: a store with a
 * declared index, the code that reads it, a route, and a client of that
 * route. Enough for a target to match a file, a line, a boundary, a
 * summary id, and nothing at all, and for one unit to record a gap.
 */

import { restBinding, storageBinding } from "@suss/behavioral-ir";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";

const CONFIDENT = { source: "inferred_static", level: "high" } as const;

function readEffect(fields: string[]): Effect {
  return {
    type: "interaction",
    binding: storageBinding({
      recognition: "aws-dynamodb-query",
      storageSystem: "aws.dynamodb",
      scope: "default",
      container: "editions",
      accessPath: "by-publication",
    }),
    callee: "docClient.query",
    interaction: {
      class: "storage-access",
      kind: "read",
      fields,
      selector: ["publicationId"],
      operation: "query",
    },
  };
}

/** The index as terraform declares it: three attributes and no more. */
export const indexContract: BehavioralSummary = {
  kind: "library",
  location: {
    file: "infra/editions.tf",
    range: { start: 1, end: 20 },
    exportName: null,
  },
  identity: {
    name: "aws_dynamodb_table.editions#by-publication",
    exportPath: null,
    boundaryBinding: storageBinding({
      recognition: "terraform",
      storageSystem: "aws.dynamodb",
      scope: "default",
      container: "editions",
      accessPath: "by-publication",
    }),
  },
  inputs: [],
  transitions: [],
  gaps: [],
  confidence: CONFIDENT,
  metadata: {
    storageContract: {
      fieldSet: "exhaustive",
      identifies: { kind: "keyFields", fields: ["publicationId"] },
      fields: [
        { name: "publicationId", type: "S", primary: true },
        { name: "editionId", type: "S" },
        { name: "title", type: "S" },
      ],
      physicalTable: "editions",
    },
  },
};

/**
 * The unit somebody is editing. Its read asks for an attribute the
 * index does not copy, and the walk stopped at one call inside it.
 */
export const dao: BehavioralSummary = {
  kind: "library",
  location: {
    file: "src/editions/dao.ts",
    range: { start: 30, end: 60 },
    exportName: "byPublication",
  },
  identity: {
    name: "byPublication",
    exportPath: ["byPublication"],
    boundaryBinding: null,
  },
  inputs: [],
  transitions: [
    {
      id: "byPublication:query",
      conditions: [],
      output: { type: "return", value: null },
      effects: [readEffect(["publicationId", "title", "wordCount"])],
      location: { start: 40, end: 50 },
      isDefault: true,
    },
    {
      id: "byPublication:empty",
      conditions: [],
      output: { type: "return", value: null },
      effects: [],
      location: { start: 52, end: 58 },
      isDefault: false,
    },
  ],
  gaps: [
    {
      type: "unfollowedCall",
      conditions: [],
      consequence: "unknown",
      description:
        "suss met a call to loadCursor and could not settle which function it is, so whatever it does is missing from this summary.",
    },
  ],
  confidence: CONFIDENT,
};

/** A second unit in the same file, so a line has something to pick out. */
export const dashboard: BehavioralSummary = {
  kind: "library",
  location: {
    file: "src/editions/dao.ts",
    range: { start: 70, end: 90 },
    exportName: "forDashboard",
  },
  identity: {
    name: "forDashboard",
    exportPath: ["forDashboard"],
    boundaryBinding: null,
  },
  inputs: [],
  transitions: [
    {
      id: "forDashboard:query",
      conditions: [],
      output: { type: "return", value: null },
      effects: [readEffect(["publicationId", "editionId"])],
      location: { start: 75, end: 85 },
      isDefault: true,
    },
  ],
  gaps: [],
  confidence: CONFIDENT,
};

/** The route, which returns a status its client never handles. */
export const route: BehavioralSummary = {
  kind: "handler",
  location: {
    file: "src/editions/routes.ts",
    range: { start: 10, end: 40 },
    exportName: "listEditions",
  },
  identity: {
    name: "listEditions",
    exportPath: ["listEditions"],
    boundaryBinding: restBinding({
      transport: "http",
      recognition: "express",
      method: "GET",
      path: "/editions",
    }),
  },
  inputs: [],
  transitions: [
    {
      id: "listEditions:200",
      conditions: [],
      output: {
        type: "response",
        statusCode: { type: "literal", value: 200 },
        body: null,
        headers: {},
      },
      effects: [],
      location: { start: 12, end: 20 },
      isDefault: true,
    },
    {
      id: "listEditions:503",
      conditions: [],
      output: {
        type: "response",
        statusCode: { type: "literal", value: 503 },
        body: null,
        headers: {},
      },
      effects: [],
      location: { start: 22, end: 30 },
      isDefault: false,
    },
  ],
  gaps: [],
  confidence: CONFIDENT,
};

/**
 * A route whose path starts with the collection route's path, so a
 * spelling that covers one covers the other unless the exact one wins.
 */
export const nestedRoute: BehavioralSummary = {
  kind: "handler",
  location: {
    file: "src/editions/routes.ts",
    range: { start: 50, end: 70 },
    exportName: "listComments",
  },
  identity: {
    name: "listComments",
    exportPath: ["listComments"],
    boundaryBinding: restBinding({
      transport: "http",
      recognition: "express",
      method: "GET",
      path: "/editions/{id}/comments",
    }),
  },
  inputs: [],
  transitions: [
    {
      id: "listComments:200",
      conditions: [],
      output: {
        type: "response",
        statusCode: { type: "literal", value: 200 },
        body: null,
        headers: {},
      },
      effects: [],
      location: { start: 52, end: 60 },
      isDefault: true,
    },
  ],
  gaps: [],
  confidence: CONFIDENT,
};

export const routeClient: BehavioralSummary = {
  kind: "client",
  location: {
    file: "web/editionsList.ts",
    range: { start: 1, end: 25 },
    exportName: "EditionsList",
  },
  identity: {
    name: "EditionsList",
    exportPath: ["EditionsList"],
    boundaryBinding: restBinding({
      transport: "http",
      recognition: "fetch",
      method: "GET",
      path: "/editions",
    }),
  },
  inputs: [],
  transitions: [
    {
      id: "EditionsList:ok",
      conditions: [],
      output: { type: "return", value: null },
      effects: [],
      location: { start: 5, end: 15 },
      isDefault: true,
    },
  ],
  gaps: [],
  confidence: CONFIDENT,
};

export const allSummaries: BehavioralSummary[] = [
  indexContract,
  dao,
  dashboard,
  route,
  routeClient,
];
