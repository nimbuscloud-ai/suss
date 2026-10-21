/** A pack that reads the literal off the syntax at the position. */
export function routePathOf(argument: {
  getLiteralValue: () => string;
}): string {
  return argument.getLiteralValue();
}
