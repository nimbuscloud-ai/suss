// What the filter reader makes of the strings a configuration writes,
// including the ones it has to refuse.

import { describe, expect, it } from "vitest";

import {
  filterCalls,
  filterTerms,
  filterValuesFor,
  parseFilterQuery,
} from "./filterQuery.js";

import type { FilterQuery } from "./filterQuery.js";

function readOrThrow(source: string): FilterQuery {
  const parsed = parseFilterQuery(source);
  if (!parsed.ok) {
    throw new Error(`${source} did not read: ${parsed.reason}`);
  }
  return parsed.query;
}

describe("a filter written as comparisons", () => {
  it("reads one comparison", () => {
    expect(readOrThrow('metric.type="a/b"')).toEqual({
      type: "term",
      key: "metric.type",
      operator: "=",
      value: "a/b",
    });
  });

  it("joins comparisons on AND and OR", () => {
    const query = readOrThrow('a="1" OR b="2" AND c="3"');
    expect(query).toMatchObject({ type: "junction", operator: "or" });
    expect(filterTerms(query).map((term) => term.key)).toEqual(["a", "b", "c"]);
  });

  it("joins two comparisons written next to each other", () => {
    const query = readOrThrow('a="1" b="2"');
    expect(query).toMatchObject({ type: "junction", operator: "and" });
  });

  it("keeps what a group and a NOT say", () => {
    const query = readOrThrow('NOT (a="1" OR a="2")');
    expect(query).toMatchObject({ type: "negation" });
    expect(filterValuesFor(query, "a")).toEqual(["1", "2"]);
  });

  it("reads a value written without quotes, and one with an escape", () => {
    expect(
      filterValuesFor(readOrThrow("value>=5 AND value<=10"), "value"),
    ).toEqual([]);
    expect(filterValuesFor(readOrThrow('label="a\\"b"'), "label")).toEqual([
      'a"b',
    ]);
    expect(filterValuesFor(readOrThrow("state=running"), "state")).toEqual([
      "running",
    ]);
  });

  it("gives back only what a key is compared to for equality", () => {
    const query = readOrThrow('a="1" AND a!="2" AND b="3"');
    expect(filterValuesFor(query, "a")).toEqual(["1"]);
  });

  it("reads a key that quotes one of its own segments", () => {
    const query = readOrThrow(
      'metric.type="a/b" AND metric.label."response_code_class"="5xx"',
    );

    expect(filterTerms(query).map((term) => term.key)).toEqual([
      "metric.type",
      "metric.label.response_code_class",
    ]);
    expect(filterValuesFor(query, "metric.label.response_code_class")).toEqual([
      "5xx",
    ]);
  });

  it("reads a call written where a comparison would be", () => {
    const query = readOrThrow(
      'select_slo_burn_rate("projects/p/services/s/serviceLevelObjectives/o", "3600s")',
    );

    expect(filterCalls(query)).toEqual([
      {
        type: "call",
        name: "select_slo_burn_rate",
        arguments: ["projects/p/services/s/serviceLevelObjectives/o", "3600s"],
      },
    ]);
    expect(filterTerms(query)).toEqual([]);
    expect(filterValuesFor(query, "metric.type")).toEqual([]);
  });

  it("keeps reading a group or a call joined onto another comparison", () => {
    const query = readOrThrow('a="1" (b="2" OR b="3") within("5m")');

    expect(filterTerms(query).map((term) => term.key)).toEqual(["a", "b", "b"]);
    expect(filterCalls(query).map((call) => call.name)).toEqual(["within"]);
  });

  it("gives back the calls and the comparisons a NOT turns around", () => {
    expect(filterCalls(readOrThrow('NOT within("5m")'))).toHaveLength(1);
    expect(filterTerms(readOrThrow('NOT within("5m")'))).toEqual([]);
    expect(filterCalls(readOrThrow('a="1"'))).toEqual([]);
  });

  it("leaves out a call argument that is neither a value nor a name", () => {
    expect(filterCalls(readOrThrow('within("5m" >= )'))[0]?.arguments).toEqual([
      "5m",
    ]);
  });

  it("says what stopped it, rather than reading as empty", () => {
    expect(parseFilterQuery("metric.type =")).toMatchObject({ ok: false });
    expect(parseFilterQuery('metric.type "a"')).toMatchObject({ ok: false });
    expect(parseFilterQuery('(a="1"')).toMatchObject({ ok: false });
    expect(parseFilterQuery('a="unterminated')).toMatchObject({ ok: false });
    expect(parseFilterQuery("")).toMatchObject({ ok: false });
    expect(parseFilterQuery('a="1" )')).toMatchObject({ ok: false });
    expect(parseFilterQuery('select_slo_burn_rate("a"')).toMatchObject({
      ok: false,
    });
  });
});
