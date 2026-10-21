// Helpers that take the variable's name as a parameter. The node pack
// reports one read for each literal a caller passes.

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  return process.env[name];
}

// Hands its parameter on unchanged, so the name comes from its callers.
export function setting(key: string): string {
  return requireEnv(key);
}

export function makeReader(prefix: string): (name: string) => string {
  return (name) => requireEnv(`${prefix}${name}`);
}

export const readEnv = (name: string): string | undefined =>
  process.env[name];

export class Settings {
  get(name: string): string | undefined {
    return process.env[name];
  }
}
