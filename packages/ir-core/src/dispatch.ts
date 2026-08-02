// dispatch.ts — the DispatchTable idiom (docs/internal/style.md,
// decision #8): dispatch on a discriminated union via a mapped-type
// Record so exhaustiveness is a type error, never a runtime
// fall-through.
//
// It lives here because the decision is repo-wide, so every package that
// walks an IR union reaches for it. Three of them had written their own
// copy before this one existed.

export type DispatchTable<T extends { type: string }, R> = {
  [K in T["type"]]: (variant: Extract<T, { type: K }>) => R;
};

export function dispatchByType<T extends { type: string }, R>(
  table: DispatchTable<T, R>,
  value: T,
): R {
  // The double cast is the deliberate seam between the well-typed table
  // (per-variant narrowing) and the runtime lookup (one cast, one place).
  const handler = (table as unknown as Record<string, (v: T) => R>)[value.type];
  return handler(value);
}
