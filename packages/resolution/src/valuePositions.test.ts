import { describe, expect, it } from "vitest";

import { RESOLUTION_QUESTIONS, RESOLUTION_RULES } from "./index.js";
import {
  addEntryRows,
  addTemplateRows,
  SPREAD_ENTRY,
  VALUE_ENTRY,
} from "./valuePositions.js";

/** The relations that say where each piece of a written value goes, which only readers outside the rules use so far. */
const VALUE_POSITION_RELATIONS = [
  "writtenEntryAt",
  "partAt",
  "holeAt",
  "elementOf",
  "elementPartOf",
  "positionOf",
];

function collected(): {
  rows: [string, string[]][];
  add: (relation: string, row: string[]) => void;
} {
  const rows: [string, string[]][] = [];
  return { rows, add: (relation, row) => rows.push([relation, row]) };
}

describe("the value position facts", () => {
  it("are read by no shared rule yet", () => {
    const read = new Set(
      [...RESOLUTION_RULES, ...RESOLUTION_QUESTIONS].flatMap((one) =>
        one.body.map((literal) => literal.relation),
      ),
    );
    expect(
      VALUE_POSITION_RELATIONS.filter((relation) => read.has(relation)),
    ).toEqual([]);
  });

  it("number a container's entries in the order they are written", () => {
    const { rows, add } = collected();
    addEntryRows(add, "list", [
      { key: "first", form: VALUE_ENTRY },
      { key: "rest", form: SPREAD_ENTRY },
    ]);
    expect(rows).toEqual([
      ["writtenEntryAt", ["list", "0", "first", "value"]],
      ["writtenEntryAt", ["list", "1", "rest", "spread"]],
    ]);
  });

  it("number a template's parts and holes together, giving text that writes nothing no row", () => {
    const { rows, add } = collected();
    addTemplateRows(add, "path", [
      { text: "" },
      { hole: "id" },
      { text: "/posts/" },
      { hole: "post" },
      { text: "" },
    ]);
    expect(rows).toEqual([
      ["holeAt", ["path", "0", "id"]],
      ["partAt", ["path", "1", "/posts/"]],
      ["holeAt", ["path", "2", "post"]],
    ]);
  });
});
