import { lit, rule, variable as v } from "@suss/datalog";

export const RULES = [
  rule(
    "invokes",
    [v("r"), v("f")],
    [lit("call", v("r"), v("c")), lit("comesTo", v("c"), v("f"))],
  ),
  rule("comesTo", [v("x"), v("x")], [lit("func", v("x"))]),
  rule(
    "wantedInvokes",
    [v("r"), v("f")],
    [lit("wanted", v("r")), lit("invokes", v("r"), v("f"))],
  ),
];
