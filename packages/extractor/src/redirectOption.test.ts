import { describe, expect, it } from "vitest";

import { redirectDeliveryWhenSet } from "./redirectOption.js";

describe("redirectDeliveryWhenSet", () => {
  const fetchOption = { name: "redirect", handsBack: ["manual", "error"] };

  it("hands the redirect back for a value the pack lists", () => {
    expect(redirectDeliveryWhenSet(fetchOption, "manual")).toBe("response");
  });

  it("follows for any other value", () => {
    expect(redirectDeliveryWhenSet(fetchOption, "follow")).toBe("followed");
  });
});
