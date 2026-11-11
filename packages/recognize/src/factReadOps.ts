/**
 * `ReadOps` answered from the facts an adapter states, so a read chain
 * runs on any adapter that states them.
 *
 * Which entry a site reads comes from `readsProperty`, `readsEntry` and
 * `readsKeyed`, and the value assigned to it from `assigns`. Whether the
 * program copes with a missing value, and the value it falls back to,
 * are each adapter's own walk behind a `FactSource` member, since what
 * counts as coping is the language's. DESIGN.md, under "The ops over the
 * facts", has the fact behind each member.
 */

import { factValueOps, functionBehind } from "./factOps.js";

import type {
  FactSource,
  KeySupplied,
  ReadOps,
  RuntimeObject,
  SuppliedKey,
  ValueOps,
} from "@suss/extractor";

/** The ops for the read site at `key`. Its `entry` is undefined when the facts don't state a read there. */
export function factReadOps(key: string, facts: FactSource): ReadOps {
  return new FactRead(key, facts);
}

/** What the facts state a site reads: the object, and the entry or null for a computed key. */
interface StatedRead {
  readonly object: string;
  readonly entry: string | null;
}

class FactRead implements ReadOps {
  private objectKey: string | null | undefined;
  private stated: StatedRead | null | undefined;
  private readonly paths = new Map<string, string | null | undefined>();

  constructor(
    private readonly key: string,
    private readonly facts: FactSource,
  ) {}

  isOff(object: RuntimeObject): boolean {
    return OFF[object.origin](this, object as never);
  }

  /**
   * The path the object is spelled as. The rules follow only the output
   * streams into a value so far, and no read chain is about a stream, so
   * nothing a read is off is asked of them.
   */
  objectPath(paths: readonly string[]): string | null | undefined {
    const asked = paths.join("\u0000");
    if (this.paths.has(asked)) {
      return this.paths.get(asked);
    }
    const object = this.object();
    const path =
      object === null
        ? undefined
        : paths.find((one) => this.facts.spellsGlobal?.(object, one) === true);
    this.paths.set(asked, path);
    return path;
  }

  entry(): string | null | undefined {
    const read = this.read();
    return read === null ? undefined : read.entry;
  }

  readsOff(): readonly ReadOps[] {
    return (this.facts.readsOff?.(this.key) ?? []).map((site) =>
      factReadOps(site, this.facts),
    );
  }

  defaulted(): boolean {
    return this.facts.defaultedAt?.(this.key) ?? false;
  }

  fallback(): ValueOps | null {
    const fallback = this.facts.fallbackOf?.(this.key) ?? null;
    return fallback === null ? null : factValueOps(fallback, this.facts);
  }

  assigned(): ValueOps | null {
    this.facts.read(this.key);
    const assigned = only(this.facts.db.lookup("assigns", 0, this.key), 1);
    return assigned === null ? null : factValueOps(assigned, this.facts);
  }

  source(): string {
    return this.facts.textOf(this.key);
  }

  keysSuppliedTo(object: RuntimeObject): readonly SuppliedKey[] | null {
    const stated =
      this.facts.keysSupplied === undefined
        ? keysOverFacts(this.key, object, this.facts)
        : this.facts.keysSupplied(this.key, object);
    return stated?.map((key) => suppliedKey(key, this.facts)) ?? null;
  }

  /**
   * The object the site reads off. An adapter that states facts on
   * demand says so without stating the site, which only the sites off a
   * runtime object ever need.
   */
  private object(): string | null {
    if (this.objectKey === undefined) {
      this.objectKey =
        this.facts.objectOf === undefined
          ? (this.read()?.object ?? null)
          : this.facts.objectOf(this.key);
    }
    return this.objectKey;
  }

  /** The one read the facts state at the site, or null unless they state exactly one. */
  private read(): StatedRead | null {
    if (this.stated === undefined) {
      this.facts.read(this.key);
      this.stated = statedRead(this.key, this.facts);
    }
    return this.stated;
  }
}

/** How each kind of runtime object checks the object a site reads off. */
const OFF: {
  readonly [K in RuntimeObject["origin"]]: (
    read: FactRead,
    object: Extract<RuntimeObject, { origin: K }>,
  ) => boolean;
} = {
  global: (read, object) => read.objectPath(object.paths) !== undefined,
  // No adapter states which parameter a platform fills yet, so a read is
  // never off one.
  handedIn: () => false,
};

/** The relations a read is stated under, the ones that spell the entry first. */
const READ_RELATIONS = ["readsProperty", "readsEntry", "readsKeyed"] as const;

function statedRead(key: string, facts: FactSource): StatedRead | null {
  for (const relation of READ_RELATIONS) {
    const reads = new Map<string, StatedRead>();
    for (const row of facts.db.lookup(relation, 0, key)) {
      const read = {
        object: String(row[1]),
        entry: relation === "readsKeyed" ? null : String(row[2]),
      };
      reads.set(`${read.object}\u0000${read.entry}`, read);
    }
    if (reads.size > 0) {
      const [one] = reads.values();
      return reads.size === 1 && one !== undefined ? one : null;
    }
  }
  return null;
}

/**
 * One supplied key as ops. The value is read only when the chain asks,
 * since a forwarded key's never is.
 */
function suppliedKey(key: KeySupplied, facts: FactSource): SuppliedKey {
  let value: ValueOps | undefined;
  return {
    at: key.at,
    forwarded: key.forwarded,
    sites: key.sites.map((site) => factReadOps(site, facts)),
    get value(): ValueOps {
      value ??= factValueOps(key.value, facts);
      return value;
    },
  };
}

/**
 * The arguments of a call whose value becomes the key of a read off the
 * object down the callee: for each parameter of the function the callee
 * comes to, the sites the adapter says take their key from it. Null for
 * an adapter that cannot say which sites a parameter supplies.
 */
function keysOverFacts(
  call: string,
  object: RuntimeObject,
  facts: FactSource,
): readonly KeySupplied[] | null {
  const sitesNaming = facts.sitesNaming;
  if (sitesNaming === undefined) {
    return null;
  }
  const callee = only(facts.db.lookup("call", 0, call), 1);
  const func = callee === null ? null : functionBehind(callee, facts);
  if (func === null) {
    return [];
  }
  const parameters = new Map(
    facts.db
      .lookup("paramOf", 0, func)
      .map((row) => [Number(row[1]), String(row[2])]),
  );
  return facts.db.lookup("callArg", 0, call).flatMap((row) => {
    const at = Number(row[1]);
    const value = String(row[2]);
    const parameter = parameters.get(at);
    const sites =
      parameter === undefined
        ? []
        : (sitesNaming(parameter) ?? []).filter((site) =>
            factReadOps(site, facts).isOff(object),
          );
    return sites.length === 0
      ? []
      : [{ at, value, forwarded: isParameter(value, facts), sites }];
  });
}

/** Whether the value is a parameter, or a name bound to one. */
function isParameter(value: string, facts: FactSource): boolean {
  const { db } = facts;
  return [
    value,
    ...db.lookup("binds", 0, value).map((row) => String(row[1])),
  ].some((key) => db.lookup("paramOf", 2, key).length > 0);
}

/** The one value in a column of these rows, or null for none or several. */
function only(
  rows: readonly (readonly unknown[])[],
  column: number,
): string | null {
  const values = new Set(rows.map((row) => String(row[column])));
  const [one] = values;
  return values.size === 1 && one !== undefined ? one : null;
}
