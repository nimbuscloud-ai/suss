interface NoteEvent {
  arguments: { id: string };
}

export async function handler(event: NoteEvent) {
  if (event.arguments.id === "") {
    throw new Error("id is required");
  }
  return { id: event.arguments.id, title: "First note" };
}
