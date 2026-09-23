/**
 * The boundary-name syntax, parsed and printed in one place.
 *
 * A name in a summary is one of three things, and the braces alone tell
 * them apart: a literal (`orders-v1`), a pattern with holes a deployment
 * fills (`{stage}-orders-v1`), or a reference that says where to look
 * the name up (`{location.bucket}`, `{ORDER_TABLE}`). A second parser
 * could classify a string differently, and a second printer could write
 * a string this parser cannot read back. So all code that reads or
 * writes the braces goes through `parseBoundaryName` and
 * `boundaryNameString`, and the other helpers here are built on those
 * two. The package README has the longer explanation, including why
 * REST route paths and message-bus channels are handled separately.
 */

import { type DispatchTable, dispatchByType } from "./dispatch.js";

/** One piece of a pattern: fixed text, or a hole. */
export type NamePart =
  | { type: "text"; text: string }
  | { type: "hole"; label: string };

/**
 * A parsed boundary name. A `reference` keeps its raw dot-separated
 * path, and `referenceOf` checks that every part is present. A
 * malformed reference still classifies as a reference, so it still
 * pairs with nothing.
 */
export type BoundaryName =
  | { type: "literal"; value: string }
  | { type: "pattern"; parts: NamePart[] }
  | { type: "reference"; path: string[] };

/** Splits a name into text and `{...}` holes, keeping the holes. */
const HOLE_SPLIT = /(\{[^}]*\})/;

/** A CloudFormation `Fn::Sub` substitution, `${X}`. */
const SUB_TOKEN = /\$\{([^}]*)\}/g;

/** CloudFormation's escape, `${!X}`, which comes out as a literal `${X}`. */
const SUB_ESCAPE = /\$\{!/;

function isHole(piece: string): boolean {
  return piece.startsWith("{") && piece.endsWith("}");
}

/** Parse a name string. The exact inverse of `boundaryNameString`. */
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

/** The name as a summary writes it. The exact inverse of `parseBoundaryName`. */
export function boundaryNameString(name: BoundaryName): string {
  return dispatchByType(nameString, name);
}

/**
 * The string for one hole. Code that builds a pattern one part at a
 * time calls this for each hole, so the result always parses back.
 */
export function patternHole(label: string): string {
  return `{${label}}`;
}

/**
 * The name pattern a CloudFormation `Fn::Sub` value produces, with each
 * `${X}` turned into a hole. In the array form the template is the
 * first element. The variable map only gives each substitution's
 * source, which does not change the pattern.
 */
export function namePatternFromSub(value: unknown): string | null {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? namePatternFromSub(value[0]) : null;
  }

  if (typeof value !== "string") {
    return null;
  }
  // An escaped substitution leaves literal braces in the name, and those
  // would parse as a hole, so there is no pattern to return.
  if (SUB_ESCAPE.test(value)) {
    return null;
  }
  return value.replace(SUB_TOKEN, (_whole, inner: string) =>
    patternHole(inner),
  );
}

/**
 * Whether a name is a reference, which gives where to look the name up
 * and not the name itself. A wrapper that takes its bucket as an
 * argument writes `{location.bucket}`. Such a name agrees with nothing
 * until it is grounded, since otherwise it would agree with every name.
 */
export function namesNothing(name: string): boolean {
  return parseBoundaryName(name).type === "reference";
}

/** Whether a name has any hole left for the deployment to fill. */
export function hasNameHole(name: string): boolean {
  return parseBoundaryName(name).type !== "literal";
}

/**
 * The name with every hole label blanked, for comparing two patterns.
 * Each side chooses its own label for a parameter, so labels never
 * decide a match.
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

/** How many characters of fixed text a name has. A reference has none. */
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
 * Whether a concrete name has the pattern's fixed text in the pattern's
 * places. A hole can cover anything, because projects do not share a
 * separator: a region is written `us-east-1`, and a hole that stopped at
 * the first hyphen would miss it. When two patterns cover one name, the
 * checker prefers the one with more fixed text as it picks a container.
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
 * other. A pattern and a concrete name agree when the fixed text is
 * where the pattern puts it. That happens when one side hardcoded what
 * the other parameterized. A reference agrees with nothing.
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

/** A parsed reference: the value the code starts from, and the fields it reads inside it. */
export interface Reference {
  /**
   * A parameter of the unit the reference was written in, or a variable
   * the deployment sets. The string does not record which. The grounding
   * pass works that out from the unit's inputs.
   */
  root: string;
  /** The fields read inside the root, outermost first. */
  fields: string[];
}

/**
 * The string for a reference, such as `{location.bucket}`. Null when
 * any part is empty, since such a reference could never be settled.
 */
export function referenceName(reference: Reference): string | null {
  const path = [reference.root, ...reference.fields];
  if (path.some((part) => part === "")) {
    return null;
  }
  return boundaryNameString({ type: "reference", path });
}

/**
 * The `Reference` in a parsed name. Null when the name is not a
 * reference, or when a part of it is empty and nothing could settle it.
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

/** The `Reference` in a name string, or null when the name is a literal or a pattern. */
export function referenceFromName(name: string): Reference | null {
  return referenceOf(parseBoundaryName(name));
}
