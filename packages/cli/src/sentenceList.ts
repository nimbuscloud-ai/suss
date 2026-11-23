/** "a", "a and b", or "a, b and c", the way a report lists names in a sentence. Pass "or" for a list of alternatives. */
export function sentenceList(
  parts: readonly string[],
  joiner: "and" | "or" = "and",
): string {
  if (parts.length <= 1) {
    return parts.join("");
  }
  return `${parts.slice(0, -1).join(", ")} ${joiner} ${parts[parts.length - 1]}`;
}
