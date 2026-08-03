// Imported by both handlers and sitting beside neither, so no pack
// stamps it with a unit. Both functions build from the service root, so
// both of their directories hold this file and neither one of them can
// claim the read below.

export function logLevel(): string {
  return process.env.LOG_LEVEL ?? "info";
}
