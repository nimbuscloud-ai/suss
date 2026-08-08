// variables.ts: the Serverless Framework's `${...}` variable syntax,
// resolved as far as the document itself can answer.
//
// `${self:...}` names a path inside the same document, so it resolves
// here. Every other source (`env:`, `opt:`, `cf:`, `ssm:`, `param:`,
// `file(...)`, and whatever a plugin registers) names a value that
// arrives at deploy time, so the reference is kept as a symbolic
// token instead of being resolved, guessed, or dropped. The token is
// the reference text as written, minus the wrapper: `env:AUDIT_QUEUE_ARN`
// tells a reader which question to ask of the environment, where null
// would only say "named at deploy time".
//
// A fallback (`${opt:region, 'us-east-1'}`) is applied only for a
// `self:` reference, where both sides are stated by the document. For
// a deploy-time source the fallback is what the framework uses when
// the CLI supplies nothing, and which way an invocation went is not a
// fact this file states, so the reference stays symbolic.

/** One string-typed value after variable resolution. */
export type ResolvedString =
  | { kind: "resolved"; value: string }
  | { kind: "symbolic"; token: string };

/** A whole-value reference can also resolve to a non-string subtree. */
export type ResolvedValue =
  | { kind: "resolved"; value: unknown }
  | { kind: "symbolic"; token: string };

const REFERENCE = /\$\{([^{}]*)\}/g;

/**
 * Resolves `${...}` references against one parsed serverless.yml
 * document. Stateless apart from the document it closes over.
 */
export interface VariableResolver {
  /**
   * Resolve a schema position that holds a scalar. A string with no
   * references resolves to itself; a string that is exactly one
   * `${self:...}` reference resolves to whatever the path holds,
   * object or scalar; anything the document cannot answer comes back
   * symbolic with its token.
   */
  resolveValue(raw: unknown): ResolvedValue;
  /**
   * `resolveValue` narrowed to string positions (a handler, a path, an
   * ARN). A whole-value reference that resolves to a number or boolean
   * is stringified the way the framework would substitute it; one that
   * resolves to an object or array is symbolic, since no string was
   * stated.
   */
  resolveString(raw: string): ResolvedString;
  /**
   * Resolve every string inside a CloudFormation subtree, in place.
   * The framework resolves its variables across the whole document
   * before it compiles anything, the `resources:` block included, so a
   * property written `${self:custom.tableName}` is a name by the time
   * CloudFormation sees it.
   *
   * One reference is left exactly as written: one whose source is not
   * the framework's. `Fn::Sub` writes `${AWS::Region}` in the same
   * syntax, and rewriting that would turn an intrinsic the document
   * meant into a token nothing answers.
   */
  resolveTemplateTree(value: unknown): unknown;
}

/**
 * The variable sources the framework's own schema defines. A reference
 * naming one of these is the framework's to resolve, whether or not
 * this reader can; a reference naming anything else belongs to whatever
 * else reads the string.
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

/** Whether a reference body names one of the framework's own sources. */
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

    // Several references, or a reference embedded in a longer string:
    // substitute what resolves to a scalar. If anything is left over,
    // the whole string is symbolic, with the leftovers still visible
    // in the token, so nothing downstream mistakes a half-substituted
    // ARN for a whole one.
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
    // A reference nested inside another one leaves text that still
    // holds `${`: only the inner reference matched, so what came back
    // is a half-built reference rather than a value the document
    // states. The framework's own rules for nesting are not written
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
      // A cycle states nothing; keep the reference external.
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
   * One string in a CloudFormation position. A reference the document
   * answers becomes what it states; a reference to a source the
   * framework defines but a deploy supplies keeps its token; a
   * reference naming no framework source is left exactly as written,
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

/**
 * The reference body when the string is exactly one `${...}` and
 * nothing else, or null when the reference is embedded in more text.
 */
function wholeReferenceBody(raw: string): string | null {
  const trimmed = raw.trim();
  const match = /^\$\{([^{}]*)\}$/.exec(trimmed);
  return match === null ? null : match[1];
}

/**
 * Split a reference body on its first top-level comma: the reference
 * itself, and the fallback the author wrote after it, if any. Commas
 * inside quotes belong to the fallback text, but v0 only ever uses a
 * fallback that is one quoted literal or number, so the first split
 * point is enough.
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
