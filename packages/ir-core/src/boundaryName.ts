/**
 * The boundary-name syntax, parsed and printed in one place.
 *
 * A name in a summary means one of three things, told apart by the
 * braces alone: a literal (`orders-v1`), a pattern with deploy-time
 * holes (`{stage}-orders-v1`), or a reference saying where to go and
 * ask (`{location.bucket}`, `{ORDER_TABLE}`). A second parser can
 * disagree about which is which, and a second printer can spell a
 * value this one cannot read back, so everything that touches the
 * braces calls this module: `parseBoundaryName` and
 * `boundaryNameString` are the two directions, and the helpers below
 * are views over them. The package README tells the longer story,
 * including why REST route paths and message-bus channels stay apart.
 */

import { type DispatchTable, dispatchByType } from "./dispatch.js";

/** One piece of a pattern: text the writer stated, or a hole. */
export type NamePart =
  | { type: "text"; text: string }
  | { type: "hole"; label: string };

/**
 * What a name string means. A `reference` keeps its raw dot-separated
 * path, and `referenceOf` is the view that checks the parts are all
 * present, so a malformed spelling still classifies as a reference and
 * still pairs with nothing.
 */
export type BoundaryName =
  | { type: "literal"; value: string }
  | { type: "pattern"; parts: NamePart[] }
  | { type: "reference"; path: string[] };

/** What a hole looks like once a writer has spelled one. */
const HOLE_SPLIT = /(\{[^}]*\})/;

/** `${X}` is a hole. */
const SUB_TOKEN = /\$\{([^}]*)\}/g;

/** CloudFormation's escape for text that survives as a literal `${X}`. */
const SUB_ESCAPE = /\$\{!/;

function isHole(piece: string): boolean {
  return piece.startsWith("{") && piece.endsWith("}");
}

/** What a name string means. The exact inverse of `boundaryNameString`. */
export function parseBoundaryName(name: string): BoundaryName {
  const parts: NamePart[] = name
    .split(HOLE_SPLIT)
    .filter((piece) => piece !== "")
    .map((piece) =>
      isHole(piece)
        ? { type: "hole", label: piece.slice(1, -1) }
        : { type: "text", text: piece },
    );
  const only = parts.length === 1 ? parts[0] : undefined;
  if (only !== undefined && only.type === "hole") {
    return { type: "reference", path: only.label.split(".") };
  }

  if (parts.some((part) => part.type === "hole")) {
    return { type: "pattern", parts };
  }

  return { type: "literal", value: name };
}

const partString: DispatchTable<NamePart, string> = {
  text: (part) => part.text,
  hole: (part) => patternHole(part.label),
};

const nameString: DispatchTable<BoundaryName, string> = {
  literal: (name) => name.value,
  pattern: (name) =>
    name.parts.map((part) => dispatchByType(partString, part)).join(""),
  reference: (name) => patternHole(name.path.join(".")),
};

/** The one serializer. Everything a summary spells goes through here. */
export function boundaryNameString(name: BoundaryName): string {
  return dispatchByType(nameString, name);
}

/**
 * How a hole is spelled. A reader that assembles a pattern a part at a
 * time, the way the adapter's name reader does, mints each hole here
 * so the spelling cannot drift from the parse above.
 */
export function patternHole(label: string): string {
  return `{${label}}`;
}

/**
 * The name a CloudFormation `Fn::Sub` value states. The array form
 * takes its template from the first element, and the variable map only
 * says where a substitution comes from, which does not change the name.
 */
export function namePatternFromSub(value: unknown): string | null {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? namePatternFromSub(value[0]) : null;
  }

  if (typeof value !== "string") {
    return null;
  }
  // A name with an escaped substitution in it keeps literal braces, and
  // braces are what a hole is written with here, so it has no pattern.
  if (SUB_ESCAPE.test(value)) {
    return null;
  }
  return value.replace(SUB_TOKEN, (_whole, inner: string) =>
    patternHole(inner),
  );
}

/**
 * Whether a name says only that somebody else knows it. A wrapper that
 * takes its bucket as an argument states `{location.bucket}` and
 * nothing more, which says which parameter to ask rather than which
 * bucket. A name like that agrees with nothing until something grounds
 * it, since otherwise it would agree with every name there is.
 */
export function namesNothing(name: string): boolean {
  return parseBoundaryName(name).type === "reference";
}

/** Whether a name has anything a source left for deploy time to fill. */
export function hasNameHole(name: string): boolean {
  return parseBoundaryName(name).type !== "literal";
}

/**
 * The form two patterns are compared in: every hole reduced to the same
 * token, since the two sides pick their own name for the parameter.
 */
export function namePatternKey(name: string): string {
  return dispatchByType<BoundaryName, string>(
    {
      literal: (parsed) => parsed.value,
      pattern: (parsed) =>
        boundaryNameString({
          type: "pattern",
          parts: parsed.parts.map((part) =>
            part.type === "hole" ? { type: "hole", label: "" } : part,
          ),
        }),
      reference: () => patternHole(""),
    },
    parseBoundaryName(name),
  );
}

/** How much of a name the writer stated rather than left for deploy time. */
export function fixedTextLength(name: string): number {
  return dispatchByType<BoundaryName, number>(
    {
      literal: (parsed) => parsed.value.length,
      pattern: (parsed) =>
        parsed.parts.reduce(
          (total, part) =>
            total + (part.type === "text" ? part.text.length : 0),
          0,
        ),
      reference: () => 0,
    },
    parseBoundaryName(name),
  );
}

function quote(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a concrete name has the pattern's fixed text in those places.
 * A hole can cover anything, because a name has no separator every
 * project agrees on: a region is written `us-east-1` and a hole that
 * stopped at the first hyphen would miss it. Two patterns that both
 * cover a name are told apart by which states more fixed text, which
 * the checker does when it picks a container.
 */
function admits(
  pattern: Extract<BoundaryName, { type: "pattern" }>,
  name: string,
): boolean {
  const source = pattern.parts
    .map((part) => (part.type === "hole" ? ".+" : quote(part.text)))
    .join("");
  return new RegExp(`^${source}$`).test(name);
}

/**
 * Whether two names are the same name. Two patterns agree when their
 * fixed parts line up, since a hole on one side meets a hole on the
 * other. A pattern and a concrete name agree when the fixed parts are
 * where the pattern says they are, which is what happens when one side
 * hardcoded what the other parameterized. A reference agrees with
 * nothing on either side.
 */
export function namesAgree(a: string, b: string): boolean {
  const left = parseBoundaryName(a);
  const right = parseBoundaryName(b);
  if (left.type === "reference" || right.type === "reference") {
    return false;
  }

  if (left.type === "pattern" && right.type === "pattern") {
    return namePatternKey(a) === namePatternKey(b);
  }

  if (left.type === "pattern") {
    return admits(left, b);
  }

  if (right.type === "pattern") {
    return admits(right, a);
  }

  return a === b;
}

/** Where a reference says to go and ask. */
export interface Reference {
  /**
   * The value the code starts from: a parameter of the unit the
   * reference was written in, or a variable the deployment sets. Which
   * of those it is depends on the unit's inputs, so the reader that
   * grounds a reference decides, not the string.
   */
  root: string;
  /** The fields to read inside it, outermost first. */
  fields: string[];
}

/**
 * How a reference is written. Null when a part of it is empty, since a
 * reference has to say what to ask about.
 */
export function referenceName(reference: Reference): string | null {
  const path = [reference.root, ...reference.fields];
  if (path.some((part) => part === "")) {
    return null;
  }
  return boundaryNameString({ type: "reference", path });
}

/**
 * The place a parsed reference says to ask, or null for a name that is
 * not a reference, or for a reference with a part missing, which says
 * nothing anybody could answer.
 */
export function referenceOf(name: BoundaryName): Reference | null {
  if (name.type !== "reference") {
    return null;
  }
  const root = name.path[0];
  if (root === undefined || name.path.some((part) => part === "")) {
    return null;
  }
  return { root, fields: name.path.slice(1) };
}

/**
 * The reference a name states, or null when the name states a name
 * rather than where to go and ask.
 */
export function referenceFromName(name: string): Reference | null {
  return referenceOf(parseBoundaryName(name));
}
