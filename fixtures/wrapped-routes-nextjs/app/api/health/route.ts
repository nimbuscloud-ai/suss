import { withAxiom } from "../../../lib/axiom/server";

const health = async () => new Response("ok", { status: 200 });

export const GET = withAxiom(health);
export const HEAD = GET;
