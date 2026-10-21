import { withAdmin } from "../../../../lib/auth/admin";

export const GET = withAdmin(async () => {
  return new Response("stats", { status: 200 });
});
