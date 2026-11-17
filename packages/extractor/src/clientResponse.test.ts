import { describe, expect, it } from "vitest";

import { clientResponseOf } from "./clientResponse.js";

describe("clientResponseOf", () => {
  it("lists each member under what it means, with the pack's deliveries", () => {
    expect(
      clientResponseOf({
        responseSemantics: [
          {
            name: "ok",
            access: "property",
            semantics: { type: "statusRange", min: 200, max: 299 },
          },
          {
            name: "status",
            access: "property",
            semantics: { type: "statusCode" },
          },
          { name: "json", access: "method", semantics: { type: "body" } },
          { name: "text", access: "method", semantics: { type: "body" } },
          {
            name: "headers",
            access: "property",
            semantics: { type: "headers" },
          },
        ],
        failureDelivery: "exception",
        redirectDelivery: "followed",
        redirectOption: { name: "redirect", handsBack: ["manual"] },
      }),
    ).toEqual({
      success: ["ok"],
      statusCode: ["status"],
      body: ["json", "text"],
      headers: ["headers"],
      failureDelivery: "exception",
      redirectDelivery: "followed",
      redirectOption: { name: "redirect", handsBack: ["manual"] },
    });
  });

  it("leaves out a status range other than success, and what the pack does not say", () => {
    expect(
      clientResponseOf({
        responseSemantics: [
          {
            name: "redirected",
            access: "property",
            semantics: { type: "statusRange", min: 300, max: 399 },
          },
        ],
      }),
    ).toEqual({});
    expect(clientResponseOf({})).toEqual({});
  });
});
