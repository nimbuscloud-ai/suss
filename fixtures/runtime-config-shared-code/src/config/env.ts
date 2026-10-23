// Imported by both handlers. Each one passes the name of a variable its
// own function declares, so the read belongs to the call that passed the
// name, and neither function is charged with the other's variable.

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is not set`);
  }
  return value;
}
