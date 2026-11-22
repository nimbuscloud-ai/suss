import { describe, expect, it } from "vitest";

import { accessDetail } from "./accessDetail.js";

describe("accessDetail", () => {
  it("gives a config read its variable as the one field it states", () => {
    expect(
      accessDetail({
        class: "config-read",
        name: "ORDERS_TABLE",
        defaulted: false,
      }),
    ).toEqual({ fields: ["ORDERS_TABLE"], by: [] });
  });

  it("states nothing for an access that names no field", () => {
    expect(accessDetail({ class: "message-send" })).toEqual({
      fields: [],
      by: [],
    });
  });
});
