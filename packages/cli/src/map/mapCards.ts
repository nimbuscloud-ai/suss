/**
 * The short list at the top of the map: a few facts worth knowing before
 * changing the code, each picked by a fixed rule over the model.
 *
 * Every rule reads facts suss recorded: a finding from `check`, an entry
 * point's reach from `ask`, an outcome's status and the middleware that
 * produced it from the summary. None of them looks at a name or a path to
 * decide what something is, so a card never says a function is a test or
 * an access check because of what it is called.
 */

import type { MapModel, MapTouch } from "./mapModel.js";

export type CardKind =
  | "finding"
  | "mostTablesWritten"
  | "getWrites"
  | "mostWrittenTable"
  | "sharedEarlyReturn"
  | "uncalledFields"
  | "notRead";

export interface Card {
  kind: CardKind;
  /** The entry points the card is about, most relevant first. */
  entries: number[];
  /** How many things the card counts. */
  total: number;
  /** The finding a finding card shows. */
  finding?: number;
  /** The table a table card is about. */
  boundary?: number;
  /** For a table card: each place that writes it, and how many entry points reach that place. */
  places?: Array<{ touch: MapTouch; entries: number }>;
  /** For a table list: one touch per table. */
  touches?: MapTouch[];
  /** For a shared early return: the outcome the entry points share. */
  outcome?: { wrapper: string; status: number; condition: string | null };
}

export interface CardRule {
  /** What the card is called on the page. */
  name: string;
  /** When the card appears, in one sentence. */
  rule: string;
  pick: (model: MapModel) => Card[];
}

const MOST_FINDINGS = 2;

export const CARD_RULES: Record<CardKind, CardRule> = {
  finding: {
    name: "Finding",
    rule: "An entry point and its caller here disagree.",
    pick: (model) =>
      model.findings
        .map((finding, at) => ({ finding, at }))
        .filter(
          ({ finding }) =>
            finding.entry !== null &&
            finding.provider.unit !== null &&
            finding.consumer.unit !== null,
        )
        .sort(
          (a, b) =>
            SEVERITY_RANK[a.finding.severity] -
            SEVERITY_RANK[b.finding.severity],
        )
        .slice(0, MOST_FINDINGS)
        .map(({ finding, at }) => ({
          kind: "finding",
          entries: [finding.entry as number],
          total: 1,
          finding: at,
        })),
  },
  mostTablesWritten: {
    name: "Most tables written",
    rule: "Writes the most tables, at least three.",
    pick: (model) => {
      const ranked = model.entries
        .map((entry, at) => ({
          at,
          tables: firstPerTable(model, entry.reach, "writes"),
        }))
        .sort((a, b) => b.tables.length - a.tables.length);
      const best = ranked[0];
      if (best === undefined || best.tables.length < 3) {
        return [];
      }
      return [
        {
          kind: "mostTablesWritten",
          entries: [best.at],
          total: best.tables.length,
          touches: best.tables,
        },
      ];
    },
  },
  getWrites: {
    name: "GET routes that write",
    rule: "GET routes whose reach writes a table.",
    pick: (model) => {
      const writing = model.entries
        .map((entry, at) => ({ entry, at }))
        .filter(
          ({ entry }) =>
            entry.kind === "rest" &&
            entry.method === "GET" &&
            firstPerTable(model, entry.reach, "writes").length > 0,
        );
      if (writing.length === 0) {
        return [];
      }
      return [
        {
          kind: "getWrites",
          entries: writing.map(({ at }) => at),
          total: writing.length,
          touches: writing.map(
            ({ entry }) =>
              firstPerTable(model, entry.reach, "writes")[0] as MapTouch,
          ),
        },
      ];
    },
  },
  mostWrittenTable: {
    name: "Most-written table",
    rule: "Written by the most entry points, at least five.",
    pick: (model) => {
      const writers = new Map<number, Set<number>>();
      model.entries.forEach((entry, at) => {
        for (const touch of entry.reach) {
          if (isTableWrite(model, touch)) {
            const set = writers.get(touch.boundary) ?? new Set<number>();
            set.add(at);
            writers.set(touch.boundary, set);
          }
        }
      });
      const best = [...writers].sort((a, b) => b[1].size - a[1].size)[0];
      if (best === undefined || best[1].size < 5) {
        return [];
      }
      const [boundary, entries] = best;
      return [
        {
          kind: "mostWrittenTable",
          entries: [...entries],
          total: entries.size,
          boundary,
          places: placesWriting(model, boundary, entries),
        },
      ];
    },
  },
  sharedEarlyReturn: {
    name: "Shared early return",
    rule: "A redirect or error that middleware adds to three or more entry points.",
    pick: (model) => {
      const groups = new Map<
        string,
        { outcome: Card["outcome"]; entries: Set<number> }
      >();
      model.entries.forEach((entry, at) => {
        for (const outcome of entry.outcomes) {
          if (
            outcome.wrapper === null ||
            outcome.status === null ||
            outcome.status < 300
          ) {
            continue;
          }
          const condition = outcome.conditions.at(-1) ?? null;
          const key = `${outcome.wrapper} ${outcome.status} ${condition}`;
          const group = groups.get(key) ?? {
            outcome: {
              wrapper: outcome.wrapper,
              status: outcome.status,
              condition,
            },
            entries: new Set<number>(),
          };
          group.entries.add(at);
          groups.set(key, group);
        }
      });
      const best = [...groups.values()].sort(
        (a, b) => b.entries.size - a.entries.size,
      )[0];
      if (best === undefined || best.entries.size < 3) {
        return [];
      }
      return [
        {
          kind: "sharedEarlyReturn",
          entries: [...best.entries],
          total: best.entries.size,
          ...(best.outcome === undefined ? {} : { outcome: best.outcome }),
        },
      ];
    },
  },
  uncalledFields: {
    name: "Fields with no caller here",
    rule: "Query and Mutation fields no operation here uses.",
    pick: (model) => {
      const fields = model.entries
        .map((entry, at) => ({ entry, at }))
        .filter(({ entry }) => entry.kind === "graphql");
      const uncalled = fields.filter(({ entry }) => entry.callers.length === 0);
      if (uncalled.length === 0 || uncalled.length === fields.length) {
        return [];
      }
      return [
        {
          kind: "uncalledFields",
          entries: uncalled.map(({ at }) => at),
          total: uncalled.length,
        },
      ];
    },
  },
  notRead: {
    name: "Not read",
    rule: "Half or more entry points have an outcome suss didn't read.",
    pick: (model) => {
      const unread = model.entries
        .map((entry, at) => ({ entry, at }))
        .filter(({ entry }) => entry.unread && entry.units.length > 0);
      const served = model.entries.filter((entry) => entry.units.length > 0);
      if (unread.length === 0 || unread.length * 2 < served.length) {
        return [];
      }
      return [
        {
          kind: "notRead",
          entries: unread.map(({ at }) => at),
          total: unread.length,
        },
      ];
    },
  },
};

/** The order cards appear in. A finding comes first because both sides of it were read. */
export const CARD_ORDER: readonly CardKind[] = [
  "finding",
  "mostTablesWritten",
  "getWrites",
  "uncalledFields",
  "mostWrittenTable",
  "sharedEarlyReturn",
];

const MOST_CARDS = 5;

/**
 * The cards for this model, in order, at most five. When most entry
 * points were not read, that card takes the last place, since every
 * other card is short by what it leaves out.
 */
export function pickCards(model: MapModel): Card[] {
  const picked = CARD_ORDER.flatMap((kind) => CARD_RULES[kind].pick(model));
  const notRead = CARD_RULES.notRead.pick(model);
  return notRead.length === 0
    ? picked.slice(0, MOST_CARDS)
    : [...picked.slice(0, MOST_CARDS - 1), ...notRead];
}

const SEVERITY_RANK: Record<string, number> = { error: 0, warning: 1, info: 2 };

/** What to call these entry points in a count: routes, fields, or both. All of them when none are given. */
export function entryNoun(
  model: MapModel,
  entries: readonly number[] = model.entries.map((_, at) => at),
): [string, string] {
  const kinds = new Set(entries.map((at) => model.entries[at]?.kind));
  if (kinds.size > 1) {
    return ["route or field", "routes and fields"];
  }
  return kinds.has("graphql") ? ["field", "fields"] : ["route", "routes"];
}

function isTableWrite(model: MapModel, touch: MapTouch): boolean {
  return (
    touch.relations.includes("writes") &&
    model.boundaries[touch.boundary]?.category === "table"
  );
}

/** One touch per table with this relation, the one with the fewest calls in between. */
export function firstPerTable(
  model: MapModel,
  reach: readonly MapTouch[],
  relation: "reads" | "writes",
): MapTouch[] {
  const first = new Map<number, MapTouch>();
  for (const touch of reach) {
    if (
      !touch.relations.includes(relation) ||
      model.boundaries[touch.boundary]?.category !== "table"
    ) {
      continue;
    }
    const seen = first.get(touch.boundary);
    if (seen === undefined || touch.through.length < seen.through.length) {
      first.set(touch.boundary, touch);
    }
  }
  return [...first.values()].sort(
    (a, b) => a.through.length - b.through.length,
  );
}

/** Each unit and call that writes the table on these entry points' reach, with how many entry points reach it. */
function placesWriting(
  model: MapModel,
  boundary: number,
  entries: ReadonlySet<number>,
): NonNullable<Card["places"]> {
  const places = new Map<string, { touch: MapTouch; entries: Set<number> }>();
  for (const at of entries) {
    for (const touch of model.entries[at]?.reach ?? []) {
      if (touch.boundary !== boundary || !isTableWrite(model, touch)) {
        continue;
      }
      const key = `${touch.unit} ${touch.via}`;
      const place = places.get(key) ?? { touch, entries: new Set<number>() };
      place.entries.add(at);
      places.set(key, place);
    }
  }
  return [...places.values()]
    .map((place) => ({ touch: place.touch, entries: place.entries.size }))
    .sort((a, b) => b.entries - a.entries);
}
