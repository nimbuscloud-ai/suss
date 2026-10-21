// The service-worker form: a trigger registered with addEventListener.

addEventListener("fetch", (event: FetchEvent) => {
  event.respondWith(new Response("hi", { status: 200 }));
});
