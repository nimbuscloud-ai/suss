// The line each operation of an OpenAPI document starts on, so a summary
// can point at where the document declares it.

import { isMap, isScalar, LineCounter, parseDocument } from "yaml";

/**
 * Keyed `${path} ${method}` as the document writes them, such as
 * `/pets/{id} get`. The YAML parser also reads JSON. An operation in
 * another file, reached through a `$ref`, has no entry.
 */
export function operationLines(text: string): Map<string, number> {
  const counter = new LineCounter();
  const document = parseDocument(text, { lineCounter: counter });
  const lines = new Map<string, number>();
  const paths = document.get("paths", true);
  if (!isMap(paths)) {
    return lines;
  }

  for (const pathEntry of paths.items) {
    if (!isScalar(pathEntry.key) || !isMap(pathEntry.value)) {
      continue;
    }
    const path = String(pathEntry.key.value);
    for (const operation of pathEntry.value.items) {
      const start = isScalar(operation.key)
        ? operation.key.range?.[0]
        : undefined;
      if (start === undefined) {
        continue;
      }
      const method = String((operation.key as { value: unknown }).value);
      lines.set(`${path} ${method.toLowerCase()}`, counter.linePos(start).line);
    }
  }
  return lines;
}
