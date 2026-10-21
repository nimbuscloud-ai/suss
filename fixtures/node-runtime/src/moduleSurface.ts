// Reads of where the module is. A bare __dirname is never visited, so
// only the property reads off it are recorded.

export function moduleUrl(): string {
  return import.meta.url;
}

export function moduleDir(): string | undefined {
  return import.meta.dirname;
}

export function depth(): number {
  return __dirname.length;
}

export function isCompiled(): boolean {
  return __filename.endsWith(".js");
}

export function here(): string {
  return __dirname;
}
