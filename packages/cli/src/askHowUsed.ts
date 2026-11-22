/**
 * `how is <unit> used`: the calls into a construct, grouped by what each
 * passes into the boundary, the callers by class or module with the entry
 * points that reach them, and what suss could not follow around it.
 *
 * `@suss/checker` works the answer out, so the map and MCP read the same
 * thing. This module turns what the user typed into units or a boundary,
 * and prints the answer. A spelling that names a class asks about every
 * method of it, ahead of a table of the same name, since a team asking
 * how `Setting` is used means the class its code calls.
 */

import { bindingIs } from "@suss/behavioral-ir";
import { classNameOf, constructUsage, functionOf } from "@suss/checker";

import { formatCondition } from "./inspect.js";
import { functionsSpelled } from "./reachTarget.js";
import { sentenceList } from "./sentenceList.js";
import { resolveTarget } from "./target.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type {
  ConstructSubject,
  ConstructUsage,
  EffectClass,
  UsageCaller,
  UsageEntryPoint,
  UsageGap,
  UsageGroup,
  UsageOutcome,
} from "@suss/checker";
import type { Answer, AnswerItem } from "./ask.js";
import type { LoadedSummaries } from "./loadedSummaries.js";

export function answerHowUsed(
  subject: string,
  loaded: LoadedSummaries,
): Answer {
  const picked = constructSubject(subject, loaded);
  if (picked.subject === null) {
    return {
      shape: "usedBy",
      subject,
      headline: picked.headline,
      items: [],
      needs: picked.needs,
      caveats: [],
      found: false,
    };
  }

  const usage = constructUsage(
    loaded.summaries,
    loaded.callFacts,
    picked.subject,
  );
  return {
    shape: "usedBy",
    subject,
    headline: headlineOf(picked.label, picked.at, usage),
    items: [
      ...usage.groups.map(groupItem),
      ...usage.callers.map(callerItem),
      ...usage.calls.map((call) => ({
        text: "",
        data: {
          kind: "call",
          caller: call.caller,
          file: call.file,
          line: call.line,
          call: call.callee,
          through: call.through,
          count: call.count,
          values: call.values,
          group: call.group,
          conditions: call.conditions.map(formatCondition),
          ...(call.kind === "possible" ? { possible: true } : {}),
        },
      })),
      ...usage.gaps.map(gapItem),
    ],
    needs: [],
    caveats: [],
    found: true,
    detail: {
      construct: {
        label: picked.label,
        ...(picked.at === null ? {} : picked.at),
        members: usage.members,
        touches: usage.touches,
        outcomes: usage.outcomes.map(printedOutcome),
        calls: callCount(usage),
        files: fileCount(usage),
        entryPoints: usage.entryPoints,
      },
    },
  };
}

/** An outcome with its conditions printed, the way the JSON gives it. */
type PrintedOutcome =
  | Exclude<UsageOutcome, { kind: "responds" }>
  | { kind: "responds"; status: number; conditions: string[] };

function printedOutcome(outcome: UsageOutcome): PrintedOutcome {
  if (outcome.kind !== "responds") {
    return outcome;
  }
  return { ...outcome, conditions: outcome.conditions.map(formatCondition) };
}

type Picked =
  | {
      subject: ConstructSubject;
      label: string;
      at: { file: string; line: number } | null;
    }
  | { subject: null; headline: string; needs: string[] };

/**
 * A unit, a file or a module first, then a class by name, then a
 * boundary. A function-call boundary is a package export, so the
 * functions behind it are the construct.
 */
function constructSubject(subject: string, loaded: LoadedSummaries): Picked {
  const { summaries, callFacts: facts } = loaded;
  const spelled = functionsSpelled(subject, summaries, facts);
  if (spelled.found && spelled.matched !== "boundary") {
    return unitsPicked(spelled.label, spelled.units, loaded);
  }

  const methods = methodsOfClass(subject, summaries);
  if (methods.length > 0) {
    return unitsPicked(subject, methods, loaded);
  }

  const resolution = resolveTarget(subject, summaries);
  if (resolution.matched && resolution.target.kind === "boundary") {
    const touches = resolution.target.touches;
    const label = touches[0]?.touched.label ?? subject;
    const inProcess = touches.every((touch) =>
      bindingIs(touch.touched.binding, "function-call"),
    );
    const providers = spelled.found
      ? spelled.target.functions.flatMap((fn) => facts.units.get(fn) ?? [])
      : [];
    if (inProcess && providers.length > 0) {
      return unitsPicked(label, providers, loaded);
    }
    return {
      subject: { kind: "boundary", touches },
      label,
      at: null,
    };
  }

  return {
    subject: null,
    headline: spelled.found
      ? `Nothing in these summaries is at ${subject}.`
      : spelled.headline,
    needs: [
      `Extract the code that defines or calls ${subject} into the same folder, then ask again. A library no pack reads, such as a cache client, is not a boundary suss records yet.`,
    ],
  };
}

/** Every summary of each function the units are summaries of, since one function can have several. */
function unitsPicked(
  label: string,
  units: ReadonlyArray<BehavioralSummary>,
  loaded: LoadedSummaries,
): Picked {
  const all = [
    ...new Set(
      units.flatMap(
        (unit) => loaded.callFacts.units.get(functionOf(unit)) ?? [unit],
      ),
    ),
  ];
  const first = [...all].sort(
    (a, b) =>
      a.location.file.localeCompare(b.location.file) ||
      a.location.range.start - b.location.range.start,
  )[0];
  return {
    subject: { kind: "units", units: all },
    label,
    at:
      first === undefined
        ? null
        : { file: first.location.file, line: first.location.range.start },
  };
}

/** The methods of a class the spelling gives, `Setting` or `Admin::Setting`. */
function methodsOfClass(
  subject: string,
  summaries: ReadonlyArray<BehavioralSummary>,
): BehavioralSummary[] {
  return summaries.filter((summary) => {
    const owner = classNameOf(summary);
    return (
      summary.receiverConstruction === undefined &&
      owner !== undefined &&
      (owner === subject || owner.endsWith(`::${subject}`))
    );
  });
}

// ---------------------------------------------------------------------------
// The answer's lines
// ---------------------------------------------------------------------------

const CLASS_WORDS: Record<EffectClass["class"], string> = {
  "service-call": "makes service calls",
  "storage-access": "reads or writes storage",
  "message-send": "sends messages",
  "config-read": "reads configuration",
  wrapper: "adds outcomes to the units it wraps",
};

function headlineOf(
  label: string,
  at: { file: string; line: number } | null,
  usage: ConstructUsage,
): string {
  const where = at === null ? "" : ` (${at.file}:${at.line})`;
  const does =
    usage.touches.length === 0
      ? "touches no boundary suss reads"
      : sentenceList(usage.touches.map(touchWords));
  const calls = callCount(usage);
  const files = fileCount(usage);
  return `${label}${where} ${does}. ${calls} call${calls === 1 ? "" : "s"} from ${files} file${files === 1 ? "" : "s"} go into it.`;
}

function touchWords(touched: EffectClass): string {
  const by =
    touched.recognition.length === 0
      ? ""
      : ` (${touched.recognition.join(", ")})`;
  const helpers = touched.throughHelpers === true ? " through its helpers" : "";
  return `${CLASS_WORDS[touched.class]}${by}${helpers}`;
}

function callCount(usage: ConstructUsage): number {
  return usage.calls.reduce((sum, call) => sum + call.count, 0);
}

function fileCount(usage: ConstructUsage): number {
  return new Set(usage.calls.map((call) => call.file)).size;
}

function groupItem(group: UsageGroup): AnswerItem {
  return {
    text: "",
    data: {
      kind: "group",
      through: group.through,
      calls: group.calls,
      values: group.values.map((value) => ({
        parameter: value.parameter,
        value: value.blanked,
      })),
      spellings: group.spellings,
    },
  };
}

function callerItem(caller: UsageCaller): AnswerItem {
  return {
    text: "",
    data: {
      kind: "caller",
      owner: caller.owner,
      calls: caller.calls,
      units: caller.units,
      files: caller.files,
      reachedBy: caller.reachedBy,
    },
  };
}

function gapItem(gap: UsageGap): AnswerItem {
  return { text: "", data: { ...gap, kind: "gap", gap: gap.kind } };
}

/** How many entry points a caller row lists before it gives a count instead. */
const ENTRY_POINTS_SHOWN = 4;

/** How many rows each table prints before it gives a count instead. */
const ROWS_SHOWN = 10;

/** The answer as text: the header, the groups, the callers, the conditions, and what suss did not follow. */
export function renderUsage(answer: Answer, all: boolean): string {
  const construct = answer.detail?.construct as
    | { outcomes: PrintedOutcome[]; entryPoints: UsageEntryPoint[] }
    | undefined;
  if (!answer.found || construct === undefined) {
    return [answer.headline, ...answer.needs.flatMap((need) => ["", need])]
      .join("\n")
      .concat("\n");
  }
  const data = answer.items.map((item) => item.data);
  const lines = [answer.headline];
  const failing = outcomeSentence(construct.outcomes);
  if (failing !== "") {
    lines.push(failing);
  }
  lines.push(
    "",
    ...groupLines(
      data.filter((item) => item.kind === "group"),
      all,
    ),
    "",
    ...callerLines(
      data.filter((item) => item.kind === "caller"),
      all,
    ),
  );
  const possible = construct.entryPoints.filter(
    (entry) => entry.possible === true,
  );
  if (possible.length > 0) {
    lines.push(
      "",
      `  ${possible.length} entry point${possible.length === 1 ? " reaches" : "s reach"} it only through a call that picks its function at run time: ${listed(
        possible.map((entry) => entry.boundary),
        all,
      )}.`,
    );
  }
  const conditions = data.filter(
    (item) => item.kind === "call" && (item.conditions as string[]).length > 0,
  );
  if (conditions.length > 0) {
    lines.push("", "  Calls that run only under a condition:");
    for (const call of shown(conditions, all)) {
      lines.push(
        `    ${call.file}:${call.line}  ${call.call}  when ${(call.conditions as string[]).join(" && ")}`,
      );
    }
    lines.push(...moreLine(conditions.length, all, "    "));
  }
  const gaps = data.flatMap((item) =>
    item.kind === "gap" ? [{ ...item, kind: item.gap } as UsageGap] : [],
  );
  if (gaps.length > 0) {
    lines.push("", "  What suss could not follow around it:");
    for (const gap of shown(gaps, all)) {
      lines.push(`    ${GAP_LINE[gap.kind](gap as never)}`);
    }
    lines.push(...moreLine(gaps.length, all, "    "));
  }
  return `${lines.join("\n")}\n`;
}

const GAP_LINE: {
  [K in UsageGap["kind"]]: (gap: Extract<UsageGap, { kind: K }>) => string;
} = {
  inside: (gap) =>
    `${gap.file}:${gap.line} ${gap.name} makes a call suss did not follow: ${gap.callee}`,
  unreached: (gap) =>
    `${gap.file}:${gap.line} ${gap.name} calls it, and no entry point in these summaries reaches ${gap.name}`,
  unfollowed: (gap) =>
    `${gap.file}:${gap.line} ${gap.name} makes a call suss did not follow, ${gap.callee}, which has the name of one of its functions${reachesThatUnit(gap.reachedBy)}`,
};

/** ". GET /a and POST /b reach that unit", or nothing when no entry point does. */
function reachesThatUnit(entries: readonly UsageEntryPoint[]): string {
  if (entries.length === 0) {
    return "";
  }
  const labels = listed(
    entries.map((entry) => entry.boundary),
    false,
  );
  return `. ${labels} reach${entries.length === 1 ? "es" : ""} that unit`;
}

function outcomeSentence(outcomes: readonly PrintedOutcome[]): string {
  const raises = outcomes.flatMap((outcome) =>
    outcome.kind === "throws" ? [outcome.type ?? "an error"] : [],
  );
  const responds = outcomes.flatMap((outcome) =>
    outcome.kind === "responds"
      ? [
          `${outcome.status}${outcome.conditions.length === 0 ? "" : ` when ${outcome.conditions.join(" && ")}`}`,
        ]
      : [],
  );
  const parts = [
    ...(raises.length === 0
      ? []
      : [`raises ${sentenceList([...new Set(raises)], "or")}`]),
    ...(outcomes.some((outcome) => outcome.kind === "returnsNothing")
      ? ["can return nothing"]
      : []),
    ...(responds.length === 0
      ? []
      : [`responds ${sentenceList(responds, "or")}`]),
  ];
  return parts.length === 0 ? "" : `It ${sentenceList(parts)}.`;
}

function groupLines(
  groups: ReadonlyArray<Record<string, unknown>>,
  all: boolean,
): string[] {
  const byThrough = new Map<string, { calls: number; passes: string[] }>();
  for (const group of groups) {
    const through = String(group.through);
    const row = byThrough.get(through) ?? { calls: 0, passes: [] };
    row.calls += Number(group.calls);
    const passes = groupPasses(group);
    if (passes !== "") {
      row.passes.push(passes);
    }
    byThrough.set(through, row);
  }
  const rows = [...byThrough].map(([through, row]) => [
    through,
    String(row.calls),
    listed(row.passes, all),
  ]);
  return [
    ...table(["Through", "calls", "passes"], shown(rows, all)),
    ...moreLine(rows.length, all, "  "),
  ];
}

/**
 * One group's values as the calls spell them, with the count when more
 * than one call shares the group. A group whose calls spell the value
 * several ways prints the two most common.
 */
function groupPasses(group: Record<string, unknown>): string {
  const values = group.values as Array<{
    parameter: string;
    value: string | null;
  }>;
  if (values.length === 0) {
    return "";
  }
  const spellings = (group.spellings as Array<{ spelled: string }>).map(
    (one) => one.spelled,
  );
  const spelled = values.every((value) => value.value === null)
    ? `nothing for ${sentenceList(values.map((value) => value.parameter))}`
    : spellingsOf(spellings);
  const calls = Number(group.calls);
  return calls === 1 ? spelled : `${spelled} (${calls})`;
}

function spellingsOf(spellings: readonly string[]): string {
  const shownHere = spellings.slice(0, 2).join(" or ");
  const rest = spellings.length - 2;
  return rest > 0 ? `${shownHere} or ${rest} more` : shownHere;
}

function callerLines(
  callers: ReadonlyArray<Record<string, unknown>>,
  all: boolean,
): string[] {
  const rows = shown(callers, all).map((caller) => {
    const reached = caller.reachedBy as UsageEntryPoint[];
    const certain = reached.filter((entry) => entry.possible !== true);
    const maybe = reached.filter((entry) => entry.possible === true);
    const by = [
      ...(certain.length === 0
        ? []
        : [
            listed(
              certain.map((entry) => entry.boundary),
              all,
            ),
          ]),
      ...(maybe.length === 0
        ? []
        : [
            `possibly ${listed(
              maybe.map((entry) => entry.boundary),
              all,
            )}`,
          ]),
    ].join("; ");
    return [
      String(caller.owner),
      String(caller.calls),
      by === "" ? "no entry point here" : by,
    ];
  });
  return [
    ...table(["Caller", "calls", "reached by"], rows),
    ...moreLine(callers.length, all, "  "),
  ];
}

/** Rows padded to line up under a header, two spaces in from the margin. */
function table(
  header: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
): string[] {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: readonly string[]) =>
    `  ${cells
      .map((cell, column) =>
        column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0),
      )
      .join("  ")}`.trimEnd();
  return [line(header), ...rows.map(line)];
}

function listed(labels: readonly string[], all: boolean): string {
  if (all || labels.length <= ENTRY_POINTS_SHOWN) {
    return labels.join(", ");
  }
  const rest = labels.length - ENTRY_POINTS_SHOWN;
  return `${labels.slice(0, ENTRY_POINTS_SHOWN).join(", ")} and ${rest} more`;
}

function shown<T>(rows: readonly T[], all: boolean): readonly T[] {
  return all ? rows : rows.slice(0, ROWS_SHOWN);
}

function moreLine(count: number, all: boolean, indent: string): string[] {
  const hidden = all ? 0 : count - ROWS_SHOWN;
  return hidden > 0
    ? [
        `${indent}... and ${hidden} more. Run the same command with --all to see them.`,
      ]
    : [];
}
