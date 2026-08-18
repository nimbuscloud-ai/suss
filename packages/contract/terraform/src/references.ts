/**
 * An interpolation that refers to another resource in the same
 * configuration, and the value that resource already states.
 *
 * Most of what Terraform interpolates is settled at deploy time, so
 * `"${local.environment}-orders"` becomes a pattern with a hole in it.
 * A reference is different: `"${google_logging_metric.refused.name}"`
 * refers to a resource in this configuration, and when that resource
 * writes its `name` as a literal string, the configuration has already
 * said what the deployed value is. Leaving it as a hole makes two sides
 * of the same configuration spell the same thing differently, and they
 * stop pairing.
 *
 * Only `<resource_type>.<label>.<attribute>` resolves, and only when
 * the resource writes that attribute as a literal string. An attribute
 * the provider fills in at apply time, an `id` or an `arn` or a
 * `self_link`, is never written in the file, so the lookup finds
 * nothing and the hole stays.
 *
 * A `locals` entry resolves the same way, since a configuration that
 * writes `local.table = "orders-v1"` has stated the name as plainly as
 * a resource does. One built from a variable expands to a value that
 * still has `${var...}` in it, which becomes a hole again, so a stage
 * prefix keeps behaving as it did. `var.`, `data.` and `module.` stay
 * out: a variable's default is not what production runs with, and the
 * other two say nothing this file can read.
 */

/** Every attribute each resource states, by the address Terraform uses. */
export type ReferenceScope = Map<string, Record<string, unknown>>;

/** `${X}` is an interpolation, the same one a name pattern reads. */
const SUB_TOKEN = /\$\{([^}]*)\}/g;

/** A reference to one attribute of one resource, and nothing else. */
const RESOURCE_ATTRIBUTE =
  /^([A-Za-z][\w-]*)\.([A-Za-z_][\w-]*)\.([A-Za-z_][\w-]*)$/;

/** `local.name`, which a `locals` block states in the same configuration. */
const LOCAL_VALUE = /^local\.([A-Za-z_][\w-]*)$/;

/** The address a locals block is kept under, which no resource can spell. */
const LOCALS = "local";

/**
 * How many hops a chain of references is followed. A resource may state
 * a name that refers to another, which refers to a third, and past a
 * few hops the hole stays rather than the chain running on.
 */
const CHAIN_LIMIT = 4;

/** Every resource a configuration states, by the address a reference spells. */
export function referenceScope(
  resources: Iterable<[string, string, Record<string, unknown>]>,
  locals: Iterable<Record<string, unknown>> = [],
): ReferenceScope {
  const scope: ReferenceScope = new Map();
  for (const [resourceType, label, body] of resources) {
    const address = `${resourceType}.${label}`;
    if (!scope.has(address)) {
      scope.set(address, body);
    }
  }
  // A module states its locals across several blocks and several files,
  // and every one of them is `local.<name>` to a reference.
  const stated: Record<string, unknown> = {};
  for (const block of locals) {
    for (const [name, value] of Object.entries(block)) {
      if (!(name in stated)) {
        stated[name] = value;
      }
    }
  }
  scope.set(LOCALS, stated);
  return scope;
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
    const stated = scope.get(LOCALS)?.[local[1] as string];
    return typeof stated === "string" ? stated : null;
  }
  const parsed = RESOURCE_ATTRIBUTE.exec(reference);
  if (parsed === null) {
    return null;
  }
  const [, resourceType, label, attribute] = parsed;
  const stated = scope.get(`${resourceType}.${label}`)?.[attribute];
  return typeof stated === "string" ? stated : null;
}
