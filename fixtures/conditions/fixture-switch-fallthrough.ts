export function classify(kind: string) {
  switch (kind) {
    case "a":
    case "b":
      return "ab";
    case "c":
      return "c";
    default:
      return "other";
  }
}

export function classifyBlock(kind: string) {
  switch (kind) {
    case "x": {
      const tag = "X-like";
      return tag;
    }
    default: {
      return "unknown";
    }
  }
}
