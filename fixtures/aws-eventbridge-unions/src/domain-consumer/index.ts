// Target of every rule. The consumer summaries come from the template,
// so this file only backs the rules' CodeUri.

export async function handler(event: {
  detail: unknown;
}): Promise<{ ok: boolean }> {
  void event.detail;
  return { ok: true };
}
