/**
 * The change list: the behavior changes an agent says it will make for
 * one request, written before it edits anything.
 *
 * It takes the boundary intent vocabulary line by line. A subject is a
 * boundary spelled the way `suss ask` spells it, or an effect written the
 * way a `results` line is. Each entry adds one verb, `adds`, `removes` or
 * `changes`, and leaves out `when`, `purpose` and `audience`, which an
 * agent cannot know before it has written the code. `explained` lists the
 * changes the agent made without being asked and keeps, each with why.
 *
 * The CLI compares a list with two readings of the code and says which
 * entries are done, and which changes nobody asked for.
 */

import { z } from "zod";

import { EffectLineSchema } from "./schema.js";
import { toIntentEffect } from "./summary.js";

import type { DeclaredEffect } from "./schema.js";
import type { IntentEffect, IntentOutcome } from "./summary.js";

const VERBS = ["adds", "removes", "changes"] as const;

export type ChangeVerb = (typeof VERBS)[number];

/** `404`, `returns`, `throws`, or `{ throws: NotFoundError }`. */
const OutcomeWordSchema = z.union([
  z.number().int().min(100).max(599),
  z.enum(["returns", "throws"]),
  z.strictObject({ throws: z.string().min(1) }),
]);

const SubjectSchema = z.union([z.string().min(1), EffectLineSchema]);

const ENTRY_FIELDS = {
  adds: SubjectSchema.optional(),
  removes: SubjectSchema.optional(),
  changes: SubjectSchema.optional(),
  outcomes: z
    .array(OutcomeWordSchema)
    .min(1)
    .describe(
      "The outcomes the boundary should have: statuses, returns or throws.",
    )
    .optional(),
  at: z
    .string()
    .min(1)
    .describe("The boundary an effect happens at, spelled as suss spells it.")
    .optional(),
};

type AuthoredEntry = {
  adds?: string | DeclaredEffect | undefined;
  removes?: string | DeclaredEffect | undefined;
  changes?: string | DeclaredEffect | undefined;
  outcomes?: z.infer<typeof OutcomeWordSchema>[] | undefined;
  at?: string | undefined;
};

function verbsOf(entry: AuthoredEntry): ChangeVerb[] {
  return VERBS.filter((verb) => entry[verb] !== undefined);
}

function subjectOf(entry: AuthoredEntry): string | DeclaredEffect | undefined {
  const [verb] = verbsOf(entry);
  return verb === undefined ? undefined : entry[verb];
}

/** The rules every entry follows, whether it is a change or an explanation. */
function withEntryRules<T extends z.ZodType<AuthoredEntry>>(schema: T) {
  return schema
    .refine((entry) => verbsOf(entry).length === 1, {
      message: "an entry has exactly one of adds, removes or changes",
    })
    .refine(
      (entry) => entry.at === undefined || typeof subjectOf(entry) !== "string",
      {
        message:
          "at says which boundary an effect happens at, so it goes with an effect; a boundary entry names its boundary itself",
      },
    )
    .refine(
      (entry) =>
        entry.outcomes === undefined || typeof subjectOf(entry) === "string",
      {
        message:
          "outcomes belong to a boundary; an effect entry says what it touches instead",
      },
    );
}

const ChangeEntrySchema = withEntryRules(
  z.strictObject({
    ...ENTRY_FIELDS,
    asked: z
      .string()
      .min(1)
      .describe(
        "The developer's words that asked for this entry, when they are not the list's.",
      )
      .optional(),
    note: z
      .string()
      .min(1)
      .describe("What the change is, for a subject suss has no words for.")
      .optional(),
  }),
);

const ExplainedEntrySchema = withEntryRules(
  z.strictObject({
    ...ENTRY_FIELDS,
    why: z
      .string()
      .min(1)
      .describe("Why the change stays, for the developer to read."),
  }),
);

export const ChangeListSchema = z.strictObject({
  asked: z
    .string()
    .min(1)
    .describe("The developer's request, quoted.")
    .optional(),
  changes: z
    .array(ChangeEntrySchema)
    .default([])
    .describe("Each behavior change the agent intends, one per entry."),
  explained: z
    .array(ExplainedEntrySchema)
    .default([])
    .describe(
      "Changes nobody asked for that the agent keeps, each with the reason.",
    ),
});

export type ChangeList = z.infer<typeof ChangeListSchema>;
export type ChangeEntry = z.infer<typeof ChangeEntrySchema>;
export type ExplainedEntry = z.infer<typeof ExplainedEntrySchema>;

// ---------------------------------------------------------------------------
// The normalized form the CLI compares against two readings of the code.
// ---------------------------------------------------------------------------

/** What an entry is about: a boundary by its spelling, or an effect. */
export type ChangeSubject =
  | { kind: "boundary"; names: string }
  | { kind: "effect"; effect: IntentEffect };

/** An outcome an entry lists, in the terms the intent checker compares. */
export type ChangeOutcome = Pick<
  IntentOutcome,
  "kind" | "status" | "errorType"
>;

export interface IntentChange {
  verb: ChangeVerb;
  subject: ChangeSubject;
  outcomes: ChangeOutcome[];
  /** The boundary an effect happens at. Null means any boundary. */
  at: string | null;
  /** The developer's words that asked for the entry: its own quote, or else the list's. */
  asked: string | null;
  note: string | null;
}

export interface ExplainedChange {
  verb: ChangeVerb;
  subject: ChangeSubject;
  outcomes: ChangeOutcome[];
  at: string | null;
  why: string;
}

export interface ChangeListSummary {
  asked: string | null;
  changes: IntentChange[];
  explained: ExplainedChange[];
}

type OutcomeWord = z.infer<typeof OutcomeWordSchema>;

const WORD_OUTCOMES: Record<"returns" | "throws", ChangeOutcome> = {
  returns: { kind: "return", status: null, errorType: null },
  throws: { kind: "throw", status: null, errorType: null },
};

function toOutcome(word: OutcomeWord): ChangeOutcome {
  if (typeof word === "number") {
    return { kind: "response", status: word, errorType: null };
  }
  if (typeof word === "string") {
    return WORD_OUTCOMES[word];
  }
  return { kind: "throw", status: null, errorType: word.throws };
}

function toSubject(written: string | DeclaredEffect): ChangeSubject {
  return typeof written === "string"
    ? { kind: "boundary", names: written }
    : { kind: "effect", effect: toIntentEffect(written) };
}

/** The verb, subject and outcomes both kinds of entry share. */
function commonOf(entry: AuthoredEntry) {
  const [verb] = verbsOf(entry) as [ChangeVerb];
  return {
    verb,
    subject: toSubject(entry[verb] as string | DeclaredEffect),
    outcomes: (entry.outcomes ?? []).map(toOutcome),
    at: entry.at ?? null,
  };
}

/** A change list, or each place where it does not fit the schema. */
export type ParsedChangeList =
  | { ok: true; list: ChangeListSummary }
  | { ok: false; problems: Array<{ path: string; message: string }> };

/** Validates a change list that is already parsed from YAML or JSON, and converts it. */
export function parseChangeList(raw: unknown): ParsedChangeList {
  const result = ChangeListSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, list: changeListToSummary(result.data) };
  }
  return {
    ok: false,
    problems: result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
}

export function changeListToSummary(list: ChangeList): ChangeListSummary {
  const asked = list.asked ?? null;
  return {
    asked,
    changes: list.changes.map((entry) => ({
      ...commonOf(entry),
      asked: entry.asked ?? asked,
      note: entry.note ?? null,
    })),
    explained: list.explained.map((entry) => ({
      ...commonOf(entry),
      why: entry.why,
    })),
  };
}
