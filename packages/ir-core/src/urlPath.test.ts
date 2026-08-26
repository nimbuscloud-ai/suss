import { describe, expect, it } from "vitest";

import { pathAfterOrigin, statesAnOrigin } from "./urlPath.js";

describe("pathAfterOrigin", () => {
  it("takes the origin off an absolute URL", () => {
    expect(pathAfterOrigin("http://backend.internal/orders")).toBe("/orders");
    expect(pathAfterOrigin("https://api.example.com:8443/v1/orders")).toBe(
      "/v1/orders",
    );
  });

  it("takes the origin off a protocol-relative URL", () => {
    expect(pathAfterOrigin("//backend.internal/orders")).toBe("/orders");
  });

  it("leaves a relative URL alone", () => {
    expect(pathAfterOrigin("/orders")).toBe("/orders");
    expect(pathAfterOrigin("orders")).toBe("orders");
  });

  it("drops the query and the fragment, which pick no route", () => {
    expect(pathAfterOrigin("/orders?page=2")).toBe("/orders");
    expect(pathAfterOrigin("/orders#top")).toBe("/orders");
    expect(pathAfterOrigin("http://host/orders?page=2#top")).toBe("/orders");
  });

  it("gives back an empty string for a URL that is only an origin", () => {
    expect(pathAfterOrigin("http://backend.internal")).toBe("");
  });
});

describe("statesAnOrigin", () => {
  it("tells an absolute URL from a path", () => {
    expect(statesAnOrigin("http://backend.internal/orders")).toBe(true);
    expect(statesAnOrigin("//backend.internal/orders")).toBe(true);
    expect(statesAnOrigin("/orders")).toBe(false);
    expect(statesAnOrigin("/api/v2")).toBe(false);
  });
});
