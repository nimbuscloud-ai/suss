/** A pack that asks the adapter what the argument is worth. */
export function routePathOf(
  argument: unknown,
  resolution: unknown,
  stringValueOf: (a: unknown, r: unknown) => string | null,
): string | null {
  return stringValueOf(argument, resolution);
}
