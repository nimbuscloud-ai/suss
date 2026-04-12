export function nested(a: boolean, b: boolean) {
  if (a) {
    if (b) {
      return "both";
    }
    return "just-a";
  }
  return "neither";
}
