// fixtures/fetch/consumer.ts — fetch API consumer
// Proves the fetch runtime pack end-to-end with a literal URL.

export async function getHealth() {
  const res = await fetch("/health");
  if (res.status === 200) {
    return res.json();
  }
  if (res.status === 503) {
    return { healthy: false };
  }
  throw new Error(`health check failed: ${res.status}`);
}
