/** "a", "a and b", or "a, b and c", the way a report lists names in a sentence. */
export function sentenceList(parts: readonly string[]): string {
  if (parts.length <= 1) {
    return parts.join("");
  }
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
