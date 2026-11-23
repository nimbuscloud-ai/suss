// Calls to the routes in server.ts. A call with a parameter in its path
// calls it something other than the route does.

export async function createNote(title: string) {
  const res = await fetch("/notes", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  return res.status;
}

export async function archiveNote(noteId: string) {
  const res = await fetch(`/notes/${noteId}/archive`, { method: "POST" });
  return res.status;
}

export async function shareNote(title: string) {
  const res = await fetch("/shared/notes", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  return res.status;
}

export async function showNote(noteId: string) {
  const res = await fetch(`/notes/${noteId}`);
  if (!res.ok) {
    return null;
  }
  return res.json();
}
