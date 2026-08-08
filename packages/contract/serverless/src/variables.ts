// variables.ts: the Serverless Framework's `${...}` variable syntax,
// resolved as far as the document itself can settle it.
//
// `${self:...}` points at a path inside the same document, so it
// resolves here. Every other source (`env:`, `opt:`, `cf:`, `ssm:`,
// `param:`, `file(...)`, and whatever a plugin registers) points at a
// value that arrives at deploy time, so the reference is kept as a
// symbolic token rather than resolved, guessed, or dropped. The token
// is the reference text as written, minus the wrapper:
// `env:AUDIT_QUEUE_ARN` tells a reader which question to ask of the
// environment, where null would only say "decided at deploy time".
//
// A fallback (`${opt:region, 'us-east-1'}`) is applied only for a
// `self:` reference, where the document states both sides. For a
// deploy-time source the fallback is what the framework uses when the
// CLI supplies nothing, and which way an invocation went is not a fact
// this file can state, so the reference stays symbolic.

/** A symbolic token is the reference text as written, minus the wrapper. */
export type ResolvedString =
  | { kind: "resolved"; value: string }
  | { kind: "symbolic"; token: string };

/** A whole-value reference can also resolve to a non-string subtree. */
export type ResolvedValue =
  | { kind: "resolved"; value: unknown }
  | { kind: "symbolic"; token: string };

const REFERENCE = /\$\{([^{}]*)\}/g;

/** Resolves `${...}` references against one parsed serverless.yml document. */
export interface VariableResolver {
  /** A whole `${self:...}` reference resolves to whatever is at that
   * path, object or scalar. */
  resolveValue(raw: unknown): ResolvedValue;
  /** A whole reference resolving to an object or array is symbolic, since no string was stated. */
  resolveString(raw: string): ResolvedString;
  /** A reference to anything the framework does not define is left
   * exactly as written. */
  resolveTemplateTree(value: unknown): unknown;
}

/**
 * The variable sources the framework's own schema defines. A reference
 * to anything else belongs to whatever else reads the string.
 */
const FRAMEWORK_SOURCES = [
  "self",
  "env",
  "opt",
  "cf",
  "s3",
  "ssm",
  "aws",
  "param",
  "sls",
  "file",
  "git",
];

function namesFrameworkSource(body: string): boolean {
  const source = body.trim().split(/[:(]/, 1)[0].trim();

  return FRAMEWORK_SOURCES.includes(source);
}

export function createVariableResolver(
  document: Record<string, unknown>,
): VariableResolver {
  function resolveString(raw: string, inProgress: Set<string>): ResolvedString {
    const value = resolveValue(raw, inProgress);
    if (value.kind === "symbolic") {
      return value;
    }
    if (typeof value.value === "string") {
      return { kind: "resolved", value: value.value };
    }
    if (typeof value.value === "number" || typeof value.value === "boolean") {
      return { kind: "resolved", value: String(value.value) };
    }
    return { kind: "symbolic", token: raw };
  }

  function resolveValue(raw: unknown, inProgress: Set<string>): ResolvedValue {
    if (typeof raw !== "string") {
      return { kind: "resolved", value: raw };
    }
    if (!raw.includes("${")) {
      return { kind: "resolved", value: raw };
    }

    const wholeReference = wholeReferenceBody(raw);
    if (wholeReference !== null) {
      return resolveReference(wholeReference, inProgress);
    }

    // A half-substituted string stays symbolic, so nothing downstream
    // mistakes a half-substituted ARN for a whole one.
    let anyUnresolved = false;
    const substituted = raw.replace(REFERENCE, (whole, body: string) => {
      const resolved = resolveReference(body, inProgress);
      if (
        resolved.kind === "resolved" &&
        (typeof resolved.value === "string" ||
          typeof resolved.value === "number" ||
          typeof resolved.value === "boolean")
      ) {
        return String(resolved.value);
      }
      anyUnresolved = true;
      return whole;
    });
    // Leftover `${` means a nested reference, where only the inner one
    // matched. The framework's own rules for nesting are not written
    // down, so the whole thing stays symbolic.
    return anyUnresolved || substituted.includes("${")
      ? { kind: "symbolic", token: substituted }
      : { kind: "resolved", value: substituted };
  }

  function resolveReference(
    body: string,
    inProgress: Set<string>,
  ): ResolvedValue {
    const { primary, fallback } = splitFallback(body);
    if (!primary.startsWith("self:")) {
      return { kind: "symbolic", token: primary };
    }

    const path = primary.slice("self:".length);
    if (inProgress.has(path)) {
      // A cycle says nothing, so keep the reference external.
      return { kind: "symbolic", token: primary };
    }
    const target = documentPath(document, path);
    if (target !== undefined) {
      inProgress.add(path);
      const resolved = resolveValue(target, inProgress);
      inProgress.delete(path);
      return resolved;
    }
    if (fallback !== null) {
      const literal = literalFallback(fallback);
      if (literal !== null) {
        return { kind: "resolved", value: literal };
      }
    }

    return { kind: "symbolic", token: primary };
  }

  /**
   * A reference to no framework source is left exactly as written,
   * because something other than the framework owns that syntax.
   */
  function resolveTemplateString(raw: string): unknown {
    const whole = wholeReferenceBody(raw);
    if (whole !== null && !namesFrameworkSource(whole)) {
      return raw;
    }
    const resolved = resolveValue(raw, new Set());

    return resolved.kind === "resolved" ? resolved.value : resolved.token;
  }

  function resolveTemplateTree(value: unknown): unknown {
    if (typeof value === "string") {
      return resolveTemplateString(value);
    }
    if (Array.isArray(value)) {
      return value.map(resolveTemplateTree);
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = resolveTemplateTree(entry);
    }

    return out;
  }

  return {
    resolveValue: (raw) => resolveValue(raw, new Set()),
    resolveString: (raw) => resolveString(raw, new Set()),
    resolveTemplateTree,
  };
}

/** Null when the reference is embedded in more text. */
function wholeReferenceBody(raw: string): string | null {
  const trimmed = raw.trim();
  const match = /^\$\{([^{}]*)\}$/.exec(trimmed);
  return match === null ? null : match[1];
}

/**
 * Splits on the first comma. A comma inside quotes belongs to the
 * fallback text, but a fallback here is one quoted literal or number,
 * so the first split point is enough.
 */
function splitFallback(body: string): {
  primary: string;
  fallback: string | null;
} {
  const comma = body.indexOf(",");
  if (comma === -1) {
    return { primary: body.trim(), fallback: null };
  }
  return {
    primary: body.slice(0, comma).trim(),
    fallback: body.slice(comma + 1).trim(),
  };
}

/** A fallback the document states outright: a quoted string or a number. */
function literalFallback(fallback: string): string | null {
  const quoted = /^'([^']*)'$/.exec(fallback) ?? /^"([^"]*)"$/.exec(fallback);
  if (quoted !== null) {
    return quoted[1];
  }
  if (/^-?\d+(\.\d+)?$/.test(fallback)) {
    return fallback;
  }

  return null;
}

/** Walk a dotted `self:` path through the document. */
function documentPath(
  document: Record<string, unknown>,
  path: string,
): unknown {
  if (path === "") {
    return undefined;
  }
  let current: unknown = document;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
