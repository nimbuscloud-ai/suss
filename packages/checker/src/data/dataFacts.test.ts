import { describe, expect, it } from "vitest";

import { readDataFacts } from "./dataFacts.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Effect,
  Output,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";
import type { Datum } from "./dataFacts.js";

const PLAYERS: BoundaryBinding = {
  transport: "postgresql",
  semantics: {
    name: "storage",
    storageSystem: "postgresql",
    scope: "default",
    container: "players",
    accessPath: null,
  },
  recognition: "test",
};

const REPORTS: BoundaryBinding = {
  ...PLAYERS,
  semantics: { ...PLAYERS.semantics, container: "reports" } as never,
};

function route(method: string, routePath: string): BoundaryBinding {
  return {
    transport: "http",
    semantics: { name: "rest", method, path: routePath },
    recognition: "test",
  };
}

const TOPIC: BoundaryBinding = {
  transport: "aws",
  semantics: { name: "message-bus", messageBus: "aws.sns", channel: "stats" },
  recognition: "test",
};

function reads(fields: string[], binding = PLAYERS): Effect {
  return {
    type: "interaction",
    binding,
    interaction: { class: "storage-access", kind: "read", fields },
  };
}

function writes(fields: string[], binding = REPORTS): Effect {
  return {
    type: "interaction",
    binding,
    interaction: { class: "storage-access", kind: "write", fields },
  };
}

function publishes(body: TypeShape): Effect {
  return {
    type: "interaction",
    binding: TOPIC,
    interaction: { class: "message-send", body },
  };
}

function calls(target: BehavioralSummary): Effect {
  return {
    type: "invocation",
    callee: target.identity.name,
    args: [],
    async: true,
    summary: target.identity.id,
  };
}

const RESPONDS: Output = {
  type: "response",
  statusCode: { type: "literal", value: 200 },
  body: { type: "text" },
  headers: {},
};

const RETURNS: Output = { type: "return", value: null };

let line = 1;

function unit(
  name: string,
  options: {
    kind?: BehavioralSummary["kind"];
    binding?: BoundaryBinding | null;
    effects?: Effect[];
    output?: Output;
    expectedInput?: TypeShape;
    file?: string;
  } = {},
): BehavioralSummary {
  const file = options.file ?? `src/${name}.ts`;
  const start = line;
  line += 20;
  const transition: Transition = {
    id: `${name}:1`,
    conditions: [],
    output: options.output ?? RETURNS,
    effects: options.effects ?? [],
    location: { start, end: start + 5 },
    isDefault: true,
    ...(options.expectedInput === undefined
      ? {}
      : { expectedInput: options.expectedInput }),
  };
  return {
    kind: options.kind ?? "library",
    location: { file, range: { start, end: start + 10 }, exportName: name },
    identity: {
      name,
      exportPath: [name],
      boundaryBinding: options.binding ?? null,
      id: `test::${file}::${name}`,
    },
    inputs: [],
    transitions: [transition],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

function handler(
  name: string,
  binding: BoundaryBinding,
  effects: Effect[],
  output: Output = RESPONDS,
): BehavioralSummary {
  return unit(name, { kind: "handler", binding, effects, output });
}

const GOLDEN: Datum = {
  kind: "column",
  at: "postgresql:players",
  scope: "postgresql:players",
  field: "golden",
};

function names(paths: ReadonlyArray<{ summary: BehavioralSummary }>): string[] {
  return paths.map((path) => path.summary.identity.name).sort();
}

describe("readDataFacts", () => {
  it("finds a path that reads the same column and responds, directly or through a helper", () => {
    const load = unit("loadPlayer", { effects: [reads(["name", "golden"])] });
    const stats = handler("stats", route("GET", "/stats"), [calls(load)]);
    const exportCsv = handler("exportCsv", route("GET", "/export"), [
      reads(["golden"]),
    ]);
    const card = handler("card", route("GET", "/card"), [calls(load)]);
    const leaderboard = handler("leaderboard", route("GET", "/top"), [
      reads(["name"]),
    ]);

    const facts = readDataFacts([load, stats, exportCsv, card, leaderboard]);
    const found = facts.sharing([GOLDEN], [stats]);

    // The helper is on the changed route's own path, so it is left out,
    // and the card reads the column through it.
    expect(names(found.sharing)).toEqual(["card", "exportCsv"]);
    expect(found.sharing[0].sends).toEqual(["responds 200"]);
  });

  it("leaves out every caller of a changed helper", () => {
    const load = unit("loadPlayer", { effects: [reads(["golden"])] });
    const stats = handler("stats", route("GET", "/stats"), [calls(load)]);
    const exportCsv = handler("exportCsv", route("GET", "/export"), [
      reads(["golden"]),
    ]);

    const found = readDataFacts([load, stats, exportCsv]).sharing(
      [GOLDEN],
      [load],
    );

    expect(names(found.sharing)).toEqual(["exportCsv"]);
  });

  it("lists a read of every column as not checked, never as a match", () => {
    const stats = handler("stats", route("GET", "/stats"), [reads(["golden"])]);
    const dump = handler("dump", route("GET", "/dump"), [reads(["*"])]);
    const unnamed = handler("unnamed", route("GET", "/raw"), [reads([])]);

    const found = readDataFacts([stats, dump, unnamed]).sharing(
      [GOLDEN],
      [stats],
    );

    expect(found.sharing).toEqual([]);
    expect(names(found.unchecked)).toEqual(["dump", "unnamed"]);
    expect(found.unchecked[0].unread[0].reason).toContain(
      "reads every column of postgresql:players",
    );
  });

  it("needs the path to send something out", () => {
    const stats = handler("stats", route("GET", "/stats"), [reads(["golden"])]);
    const quiet = unit("countGolden", { effects: [reads(["golden"])] });
    const archive = unit("archive", {
      effects: [reads(["golden"]), writes(["golden"])],
    });

    const found = readDataFacts([stats, quiet, archive]).sharing(
      [GOLDEN],
      [stats],
    );

    expect(names(found.sharing)).toEqual(["archive"]);
    expect(found.sharing[0].sends).toEqual(["writes postgresql:reports"]);
  });

  it("lists a helper that sends the data once, under the route that calls it", () => {
    const stats = handler("stats", route("GET", "/stats"), [reads(["golden"])]);
    const report = unit("writeReport", {
      effects: [reads(["golden"]), writes(["golden"])],
    });
    const nightly = handler("nightly", route("POST", "/nightly"), [
      calls(report),
    ]);

    const found = readDataFacts([stats, report, nightly]).sharing(
      [GOLDEN],
      [stats],
    );

    expect(names(found.sharing)).toEqual(["nightly"]);
    expect(found.sharing[0].sends).toEqual([
      "responds 200",
      "writes postgresql:reports",
    ]);
  });

  it("leaves out test code", () => {
    const stats = handler("stats", route("GET", "/stats"), [reads(["golden"])]);
    const spec = unit("statsSpec", {
      kind: "test",
      effects: [reads(["golden"]), writes(["golden"])],
      file: "src/stats.test.ts",
    });

    const found = readDataFacts([stats, spec]).sharing([GOLDEN], [stats]);

    expect(found.sharing).toEqual([]);
  });

  it("matches a response field only on the same side of the same boundary", () => {
    const stats = handler("stats", route("GET", "/stats"), [], {
      ...RESPONDS,
      body: { type: "record", properties: { golden: { type: "integer" } } },
    });
    const body: TypeShape = {
      type: "record",
      properties: {
        body: {
          type: "record",
          properties: { golden: { type: "integer" } },
        },
      },
    };
    const screenClient = unit("fetchStats", {
      kind: "client",
      binding: route("GET", "/stats"),
      expectedInput: body,
    });
    const csvClient = unit("fetchForCsv", {
      kind: "client",
      binding: route("GET", "/stats"),
      expectedInput: body,
    });
    const screen = unit("StatsPanel", {
      kind: "component",
      effects: [calls(screenClient)],
      output: { type: "render", component: "Panel" },
    });
    const csv = unit("downloadCsv", {
      kind: "component",
      effects: [calls(csvClient)],
      output: { type: "render", component: "Link" },
    });

    const facts = readDataFacts([stats, screenClient, csvClient, screen, csv]);
    const onScreen = facts.dataOn([
      { summary: screen, transition: screen.transitions[0] },
    ]);
    const data = [...onScreen.values()][0].named;
    expect(data).toEqual([
      {
        kind: "reads",
        at: "GET /stats",
        scope: "GET /stats",
        field: "golden",
      },
    ]);

    const found = facts.sharing(data, [screen]);

    // The route sends the field and does not read it, so it is not on
    // the same side as the screen.
    expect(names(found.sharing)).toEqual(["downloadCsv"]);
  });

  it("matches a field another producer puts in a message on the same channel", () => {
    const golden: TypeShape = {
      type: "record",
      properties: { golden: { type: "integer" } },
    };
    const nightly = unit("nightly", { effects: [publishes(golden)] });
    const weekly = unit("weekly", { effects: [publishes(golden)] });

    const facts = readDataFacts([nightly, weekly]);
    const data = [
      ...facts
        .dataOn([{ summary: nightly, transition: nightly.transitions[0] }])
        .values(),
    ][0].named;
    const found = facts.sharing(data, [nightly]);

    expect(names(found.sharing)).toEqual(["weekly"]);
    expect(found.sharing[0].sends).toEqual(["publishes to bus:aws.sns stats"]);
  });

  it("says why a body could not be read field by field", () => {
    const stats = handler("stats", route("GET", "/stats"), [], {
      ...RESPONDS,
      body: { type: "ref", name: "Player" },
    });

    const data = [
      ...readDataFacts([stats])
        .dataOn([{ summary: stats, transition: stats.transitions[0] }])
        .values(),
    ][0];

    expect(data.named).toEqual([]);
    expect(data.unread.map((one) => one.reason)).toEqual([
      "responds with a body whose fields suss could not read",
    ]);
  });
});
