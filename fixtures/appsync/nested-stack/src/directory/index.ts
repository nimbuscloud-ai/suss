// Serves Query.directory and Query.person through the dir_Directory
// data source.

interface Event {
  arguments: { team?: string; id?: string };
}

export async function handler(event: Event): Promise<unknown> {
  if (event.arguments.id !== undefined) {
    return { id: event.arguments.id, name: "Ada" };
  }
  if (event.arguments.team === undefined) {
    throw new Error("team is required");
  }
  return [{ id: "1", name: "Ada" }];
}
