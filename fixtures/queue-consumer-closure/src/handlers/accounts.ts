// Runs in AccountsFunction behind an HTTP route. Nothing here reads the
// queue, so its call is not the worker's to repeat.

export async function handler(event: { body: string }): Promise<{
  statusCode: number;
}> {
  await fetch("https://accounts.example.internal/v1/accounts", {
    method: "POST",
    body: event.body,
  });
  return { statusCode: 201 };
}
