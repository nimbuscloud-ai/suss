/**
 * Dispatch on a discriminated union through a mapped-type Record, so a
 * table that misses a variant fails to compile. This is decision #8 in
 * the internal style guide.
 *
 * Every package that walks an IR union needs it, so it lives in ir-core
 * and packages do not keep their own copies.
 */

export type DispatchTable<T extends { type: string }, R> = {
  [K in T["type"]]: (variant: Extract<T, { type: K }>) => R;
};

export function dispatchByType<T extends { type: string }, R>(
  table: DispatchTable<T, R>,
  value: T,
): R {
  // A lookup by `value.type` cannot narrow the table's per-variant
  // handler types, so the cast happens once, here.
  const handler = (table as unknown as Record<string, (v: T) => R>)[value.type];
  return handler(value);
}
