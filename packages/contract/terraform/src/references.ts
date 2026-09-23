/**
 * Resolving an interpolation that refers to something the same
 * configuration writes as a literal.
 *
 * Most of what Terraform interpolates is known only at deploy time, so
 * `"${local.environment}-orders"` becomes a pattern with a hole in it.
 * `"${google_logging_metric.refused.name}"` refers to a resource in this
 * configuration, and when that resource writes its `name` as a literal,
 * the deployed value is already known. Leaving a hole there would make
 * two sides of one configuration write the same name differently, and
 * they would stop pairing. DESIGN.md says which references resolve, and
 * why a `variable` block's `default` does not.
 */

/**
 * Everything a reference in one module can reach. Each module has its
 * own scope, since a child's `local.stage` is its own, and the parent
 * reaches the child only through its outputs.
 */
export interface ReferenceScope {
  /**
   * Every attribute each resource states, by the address Terraform
   * uses, and one entry per child module keyed `module.<label>` whose
   * attributes are that child's outputs.
   */
  resources: Map<string, Record<string, unknown>>;
  /** Every local the module defines, by name. */
  locals: Record<string, unknown>;
  /**
   * What the calling `module` block passed in, by variable name, with
   * the parent's own references already resolved. A string is what a
   * `${var.x}` in the child resolves to; a map is what a `for_each`
   * over `var.x` iterates.
   */
  arguments: Record<string, unknown>;
  /** The `default` of each `variable` block. Only a `for_each` reads these. */
  defaults: Record<string, unknown>;
  /**
   * The prefix on the name of everything this module declares, such as
   * `module.api.` inside a child, so two calls of one module do not
   * collide. Empty at the root.
   */
  namePrefix: string;
}

/** An interpolation, `${X}`. */
const SUB_TOKEN = /\$\{([^}]*)\}/g;

/**
 * Replaces each interpolation with what `settle` returns for the
 * reference inside it, and leaves it as written when `settle` returns
 * null. Only this function and `interpolatedReferences` parse
 * Terraform's `${}`, so callers go through them instead of writing a
 * second parser.
 */
export function replaceInterpolations(
  text: string,
  settle: (reference: string) => string | null,
): string {
  return text.replace(
    SUB_TOKEN,
    (written, inner: string) => settle(inner.trim()) ?? written,
  );
}

/** Every reference a text interpolates, in the order it writes them. */
export function interpolatedReferences(text: string): string[] {
  return [...text.matchAll(SUB_TOKEN)].map((match) =>
    (match[1] as string).trim(),
  );
}

/** A reference to one attribute of one resource, and nothing else. */
const RESOURCE_ATTRIBUTE =
  /^([A-Za-z][\w-]*)\.([A-Za-z_][\w-]*)\.([A-Za-z_][\w-]*)$/;

/** A value that is one interpolation and no text of its own. */
const WHOLE_REFERENCE = /^\$\{([^}]*)\}$/;

/** `local.name`, which a `locals` block states in the same configuration. */
const LOCAL_VALUE = /^local\.([A-Za-z_][\w-]*)$/;

/** `var.name`, which the calling `module` block sets inside a child. */
const VARIABLE_VALUE = /^var\.([A-Za-z_][\w-]*)$/;

/**
 * How many hops a chain of references is followed, as when one
 * resource's name refers to another's, which refers to a third. Past
 * that the hole stays.
 */
const CHAIN_LIMIT = 4;

/** Builds one module's scope, keyed by the addresses its references use. */
export function referenceScope(opts: {
  resources: Iterable<[string, string, Record<string, unknown>]>;
  locals?: Iterable<Record<string, unknown>>;
  arguments?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  namePrefix?: string;
}): ReferenceScope {
  const resources = new Map<string, Record<string, unknown>>();
  for (const [resourceType, label, body] of opts.resources) {
    const address = `${resourceType}.${label}`;
    if (!resources.has(address)) {
      resources.set(address, body);
    }
  }
  return {
    resources,
    locals: firstOfEach(opts.locals ?? []),
    arguments: opts.arguments ?? {},
    defaults: opts.defaults ?? {},
    namePrefix: opts.namePrefix ?? "",
  };
}

/**
 * A module can define its locals across several blocks and files, and a
 * reference reads all of them as `local.<name>`. The first value for
 * each name wins.
 */
function firstOfEach(
  blocks: Iterable<Record<string, unknown>>,
): Record<string, unknown> {
  const stated: Record<string, unknown> = {};
  for (const block of blocks) {
    for (const [name, value] of Object.entries(block)) {
      if (!(name in stated)) {
        stated[name] = value;
      }
    }
  }
  return stated;
}

/**
 * The label of the resource a value refers to, when the value is that
 * reference and nothing else.
 *
 * A queue URL or a table ARN exists only once the configuration is
 * applied, so a variable set to one contains a reference and no text.
 * The deployable and the resource's own summary both use the label, so
 * the chain from a variable to a resource resolves to it.
 *
 * Null when the value has text around the reference, or when it refers
 * to a local or a variable instead of a resource in this configuration.
 */
export function referencedResource(
  value: string,
  scope: ReferenceScope,
): string | null {
  const whole = WHOLE_REFERENCE.exec(value.trim());
  if (whole === null) {
    return null;
  }
  const parsed = RESOURCE_ATTRIBUTE.exec((whole[1] as string).trim());
  if (parsed === null) {
    return null;
  }
  const [, resourceType, label] = parsed;
  return scope.resources.has(`${resourceType}.${label}`)
    ? `${scope.namePrefix}${label}`
    : null;
}

/**
 * Replaces each reference with the literal the configuration writes for
 * it. Anything else stays as written, so the caller still reads it as a
 * hole.
 */
export function resolveReferences(
  value: string,
  scope: ReferenceScope,
): string {
  return expand(value, scope, []) ?? value;
}

/**
 * Null when a reference leads back into `resolving`, the chain so far.
 * Two resources that refer to each other describe nothing deployable,
 * so the caller keeps the value as written.
 */
function expand(
  value: string,
  scope: ReferenceScope,
  resolving: string[],
): string | null {
  let cycled = false;
  const expandOne = (reference: string): string | null => {
    if (resolving.includes(reference)) {
      cycled = true;
      return null;
    }
    const stated = statedValue(reference, scope);
    if (stated === null || resolving.length >= CHAIN_LIMIT) {
      return null;
    }
    const nested = expand(stated, scope, [...resolving, reference]);
    if (nested === null) {
      cycled = true;
      return null;
    }
    return nested;
  };
  const expanded = replaceInterpolations(value, expandOne);
  return cycled ? null : expanded;
}

/** What the configuration writes at a reference, when that is a string. */
function statedValue(reference: string, scope: ReferenceScope): string | null {
  const local = LOCAL_VALUE.exec(reference);
  if (local !== null) {
    return stringOrNull(scope.locals[local[1] as string]);
  }
  const variable = VARIABLE_VALUE.exec(reference);
  if (variable !== null) {
    return stringOrNull(scope.arguments[variable[1] as string]);
  }
  const parsed = RESOURCE_ATTRIBUTE.exec(reference);
  if (parsed === null) {
    return null;
  }
  const [, resourceType, label, attribute] = parsed;
  return stringOrNull(
    scope.resources.get(`${resourceType}.${label}`)?.[attribute],
  );
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
