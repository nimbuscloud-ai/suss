/**
 * Which effects each path of a route lists, and where each effect is
 * written, through the extract a user runs, in each language suss reads.
 *
 * The three fixtures write the same routes. Each route reads a row, then
 * leaves early on a guard, inside a loop of writes, or inside a try whose
 * cleanup writes an audit row. A path lists only the effects that can run
 * before it ends, and every effect says which lines it was written on.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extract } from "./extract.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";

const fixtures = path.resolve(__dirname, "../../../fixtures");

let out: string;

beforeEach(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), "suss-effect-placement-"));
});

afterEach(() => {
  fs.rmSync(out, { recursive: true, force: true });
});

async function summariesOf(
  fixture: string,
  options: { lang?: "python" | "ruby"; frameworks: string[] },
): Promise<BehavioralSummary[]> {
  const dir = path.join(fixtures, fixture);
  return await extract({
    dir,
    ...(options.lang === undefined ? {} : { lang: options.lang }),
    frameworks: options.frameworks.map((spec) =>
      spec.replace("=", `=${dir}${path.sep}`),
    ),
    output: path.join(out, "summaries.json"),
    noCache: true,
    quiet: true,
  });
}

const typescript = () =>
  summariesOf("effect-placement", { frameworks: ["express", "aws-dynamodb"] });

const python = () =>
  summariesOf("effect-placement-python", {
    lang: "python",
    frameworks: ["fastapi", "sqlmodel=suss.sqlmodel.json"],
  });

const ruby = () =>
  summariesOf("effect-placement-ruby", {
    lang: "ruby",
    frameworks: [
      "rails=suss.rails.json",
      "activerecord=suss.activerecord.json",
    ],
  });

/** The storage work one path of a unit lists, as `kind container@line`. */
function storageOn(
  summaries: readonly BehavioralSummary[],
  unit: string,
  status: number,
): string[] {
  const transition = summaries
    .find((summary) => summary.identity.name === unit)
    ?.transitions.find(
      (one) =>
        one.output.type === "response" &&
        one.output.statusCode?.type === "literal" &&
        one.output.statusCode.value === status,
    );
  if (transition === undefined) {
    throw new Error(`${unit} has no ${status} path`);
  }
  return transition.effects.flatMap((effect) => {
    if (
      effect.type !== "interaction" ||
      effect.interaction.class !== "storage-access"
    ) {
      return [];
    }
    const semantics = effect.binding.semantics;
    const container =
      semantics.name === "storage" ? (semantics.container ?? "?") : "?";
    return [
      `${effect.interaction.kind} ${container}@${effect.location?.start}`,
    ];
  });
}

function everyEffect(summaries: readonly BehavioralSummary[]): Effect[] {
  return summaries.flatMap((summary) =>
    summary.transitions.flatMap((transition) => transition.effects),
  );
}

describe("TypeScript: an Express route over DynamoDB", () => {
  it("leaves the write off the paths that respond before it", async () => {
    const summaries = await typescript();

    expect(storageOn(summaries, "put", 404)).toEqual(["read items@17"]);
    expect(storageOn(summaries, "put", 403)).toEqual(["read items@17"]);
    expect(storageOn(summaries, "put", 200)).toEqual([
      "read items@17",
      "write items@26",
    ]);
  });

  it("keeps a write an earlier pass of the loop made, and drops the one after the loop", async () => {
    const summaries = await typescript();

    expect(storageOn(summaries, "post", 400)).toEqual(["write items@40"]);
  });

  it("keeps cleanup on a path that left the try, and off one that left before it", async () => {
    const summaries = await typescript();

    expect(storageOn(summaries, "delete", 400)).toEqual([]);
    expect(storageOn(summaries, "delete", 404)).toEqual([
      "read items@55",
      "write audit@66",
    ]);
  });

  it("says which lines each effect was written on", async () => {
    const summaries = await typescript();
    const write = everyEffect(summaries).find(
      (effect) =>
        effect.type === "interaction" &&
        effect.interaction.class === "storage-access" &&
        effect.interaction.kind === "write" &&
        effect.location?.start === 26,
    );

    expect(write?.location).toEqual({ start: 26, end: 31 });
    expect(everyEffect(summaries).filter((one) => !one.location)).toEqual([]);
  });
});

describe("Python: a FastAPI route over SQLModel", () => {
  it("leaves the add and the commit off the paths that raise before them", async () => {
    const summaries = await python();

    expect(storageOn(summaries, "update_item", 404)).toEqual(["read Item@30"]);
    expect(storageOn(summaries, "update_item", 403)).toEqual(["read Item@30"]);
    expect(storageOn(summaries, "update_item", 200)).toEqual([
      "read Item@30",
      "write Item@36",
      "write ?@37",
    ]);
  });

  it("keeps an add an earlier pass of the loop made, and drops the ones after the loop", async () => {
    const summaries = await python();

    expect(storageOn(summaries, "create_items", 400)).toEqual([
      "write Item@46",
    ]);
  });

  it("keeps cleanup on a path that left the try, and off one that left before it", async () => {
    const summaries = await python();

    expect(storageOn(summaries, "delete_item", 400)).toEqual([]);
    expect(storageOn(summaries, "delete_item", 404)).toEqual([
      "read Item@57",
      "write Audit@63",
      "write ?@64",
    ]);
  });

  it("says which line each effect was written on", async () => {
    const summaries = await python();

    expect(everyEffect(summaries).filter((one) => !one.location)).toEqual([]);
  });
});

describe("Ruby: a Rails action over ActiveRecord", () => {
  it("leaves the update off the paths that respond before it", async () => {
    const summaries = await ruby();

    expect(storageOn(summaries, "update", 404)).toEqual(["read Item@6"]);
    expect(storageOn(summaries, "update", 403)).toEqual(["read Item@6"]);
    expect(storageOn(summaries, "update", 200)).toEqual([
      "read Item@6",
      "write Item@10",
    ]);
  });

  it("keeps a write an earlier pass of the block made, and drops the one after the block", async () => {
    const summaries = await ruby();

    expect(storageOn(summaries, "create", 400)).toEqual(["write Item@17"]);
  });

  it("keeps cleanup on a path that left the begin, and off one that left before it", async () => {
    const summaries = await ruby();

    expect(storageOn(summaries, "destroy", 400)).toEqual([]);
    expect(storageOn(summaries, "destroy", 404)).toEqual([
      "read Item@27",
      "write Audit@32",
    ]);
  });

  it("says which line each effect was written on", async () => {
    const summaries = await ruby();

    expect(everyEffect(summaries).filter((one) => !one.location)).toEqual([]);
  });
});
