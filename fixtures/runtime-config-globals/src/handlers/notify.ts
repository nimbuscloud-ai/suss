// Runs in NotifyFunction, which declares no environment of its own and
// takes the whole of it from the Globals section. It reads none of what
// the section supplies, which is ordinary: a default is written for the
// functions that want it.

export async function handler(event: { id: string }): Promise<{
  statusCode: number;
}> {
  await notify(event.id);
  return { statusCode: 200 };
}

async function notify(_id: string): Promise<void> {
  // Stub.
}
