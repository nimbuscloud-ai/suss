/**
 * The DispatchTable idiom: dispatch on a discriminated union through a
 * mapped-type Record, so a missing variant is a type error rather than a
 * runtime fall-through. It is decision #8 in docs/internal/style.md.
 *
 * It is here rather than in one package because the decision applies
 * repo-wide, and every package that walks an IR union needs it. Three
 * of them had written their own copy before this one existed.
 */

export type DispatchTable<T extends { type: string }, R> = {
  [K in T["type"]]: (variant: Extract<T, { type: K }>) => R;
};

export function dispatchByType<T extends { type: string }, R>(
  table: DispatchTable<T, R>,
  value: T,
): R {
  // The double cast is the deliberate join between the well-typed table,
  // which narrows per variant, and the runtime lookup, which casts once
  // and does it in one place.
  const handler = (table as unknown as Record<string, (v: T) => R>)[value.type];
  return handler(value);
}
