// A call that gives up after a while: the fetch pack makes the function
// a client, and the node pack gives the timeout callback beside it a
// unit of its own.

export async function loadWithTimeout(postId: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const response = await fetch(`/api/posts/${postId}`, {
    signal: controller.signal,
  });
  clearTimeout(timer);
  return response;
}
