/**
 * An interpolation that refers to something the same configuration
 * already states, and the value it states.
 *
 * Most of what Terraform interpolates is settled at deploy time, so
 * `"${local.environment}-orders"` becomes a pattern with a hole in it.
 * A reference is different: `"${google_logging_metric.refused.name}"`
 * refers to a resource in this configuration, and when that resource
 * writes its `name` as a literal string, the configuration has already
 * said what the deployed value is. Leaving it as a hole makes two sides
 * of the same configuration spell the same thing differently, and they
 * stop pairing. The DESIGN says which spelling settles what, and why a
 * `variable` block's `default` is not one of them.
 */

/**
 * What a configuration states, as everything a reference in it can
 * reach. One scope per module, since a child's `local.stage` is its
 * own, and the two are joined by the outputs the parent reads.
 */
export interface ReferenceScope {
  /**
   * Every attribute each resource states, by the address Terraform
   * uses, and one entry per child module keyed `module.<label>` whose
   * attributes are that child's outputs.
   */
  resources: Map<string, Record<string, unknown>>;
  /** What every `locals` block in the module states, by name. */
  locals: Record<string, unknown>;
  /**
   * What the calling `module` block passed in, by variable name, with
   * the parent's own references already resolved. A string is what a
   * `${var.x}` in the child resolves to; a map is what a `for_each`
   * over `var.x` iterates.
   */
  arguments: Record<string, unknown>;
  /** The `default` each `variable` block states, for a `for_each` alone. */
  defaults: Record<string, unknown>;
  /**
   * What goes in front of the name of everything this module declares,
   * `module.api.` inside a child, so two calls of one module do not
   * collide. Empty at the root.
   */
  namePrefix: string;
}

/** `${X}` is an interpolation, the same one a name pattern reads. */
const SUB_TOKEN = /\$\{([^}]*)\}/g;

/** A reference to one attribute of one resource, and nothing else. */
const RESOURCE_ATTRIBUTE =
  /^([A-Za-z][\w-]*)\.([A-Za-z_][\w-]*)\.([A-Za-z_][\w-]*)$/;

/** A value that is one interpolation and no text of its own. */
const WHOLE_REFERENCE = /^\$\{([^}]*)\}$/;

/** `local.name`, which a `locals` block states in the same configuration. */
const LOCAL_VALUE = /^local\.([A-Za-z_][\w-]*)$/;

/** `var.name`, which the calling `module` block states inside a child. */
const VARIABLE_VALUE = /^var\.([A-Za-z_][\w-]*)$/;

/**
 * How many hops a chain of references is followed. A resource may state
 * a name that refers to another, which refers to a third, and past a
 * few hops the hole stays rather than the chain running on.
 */
const CHAIN_LIMIT = 4;

/** What one module states, by the address a reference in it spells. */
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
 * One record out of many, keeping the first value each name was given.
 * A module states its locals across several blocks and several files,
 * and every one of them is `local.<name>` to a reference.
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
 * The resource a value refers to and nothing else, by the label the
 * rest of the configuration refers to it as.
 *
 * A queue URL and a table ARN exist only once the configuration is
 * applied, so a variable set to one of them states a reference and no
 * text at all. The two sides mean one resource, and the label is what
 * both the deployable and the resource's own summary spell, so the
 * chain from a variable to a resource collapses on it.
 *
 * Null when the value has text of its own around the reference, or
 * when it refers to a local or a variable rather than to a resource
 * this configuration states.
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
 * The same value, with each reference replaced by what the resource it
 * refers to states. Everything else is left as it was written, so the
 * caller still reads it as a hole.
 */
export function resolveReferences(
  value: string,
  scope: ReferenceScope,
): string {
  return expand(value, scope, []) ?? value;
}

/**
 * The value expanded, or null when a reference in it leads back to one
 * being resolved. Two resources that refer to each other say nothing
 * either of them could deploy, so the value is left as it was written.
 *
 * `resolving` is the chain so far, which is both how a cycle is spotted
 * and how far the chain has gone.
 */
function expand(
  value: string,
  scope: ReferenceScope,
  resolving: string[],
): string | null {
  let cycled = false;
  const expanded = value.replace(SUB_TOKEN, (written, inner: string) => {
    const reference = inner.trim();
    if (resolving.includes(reference)) {
      cycled = true;
      return written;
    }
    const stated = statedValue(reference, scope);
    if (stated === null || resolving.length >= CHAIN_LIMIT) {
      return written;
    }
    const nested = expand(stated, scope, [...resolving, reference]);
    if (nested === null) {
      cycled = true;
      return written;
    }
    return nested;
  });
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
