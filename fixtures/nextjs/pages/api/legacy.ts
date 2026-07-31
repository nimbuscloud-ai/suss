// A pages handler, which answers every method through one export and
// writes to the response it was handed.

type Req = { method?: string };
type Res = {
  status(code: number): Res;
  json(body: unknown): void;
};

export default function handler(req: Req, res: Res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "method not allowed" });
  }

  return res.status(200).json({ ok: true });
}
