// Runs in IndexerFunction and reads the one variable that function
// declares. Nothing in the file path says so; the template points at
// the same CodeUri for the notifier next door.

import { logLevel } from "../config/logging.js";

export async function handler(event: { id: string }): Promise<{
  statusCode: number;
}> {
  await writeIndexEntry(indexTable(), `${event.id}:${logLevel()}`);
  return { statusCode: 200 };
}

/**
 * Exported beside the handler, and reading the same variable. A pack
 * discovers the handler and leaves this alone, so the only thing that
 * says where it runs is the module it shares with the handler.
 */
export function indexTable(): string | undefined {
  return process.env.INDEX_TABLE_NAME;
}

async function writeIndexEntry(
  _table: string | undefined,
  _id: string,
): Promise<void> {
  // Stub. The pairing pass only cares about the env-var read above.
}
