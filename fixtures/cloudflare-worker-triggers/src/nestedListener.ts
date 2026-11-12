// A registration inside a function runs only when something calls the
// function, so the pack doesn't make it a trigger.

export function registerLater(): void {
  addEventListener("fetch", (event: FetchEvent) => {
    event.respondWith(new Response("registered late", { status: 200 }));
  });
}
