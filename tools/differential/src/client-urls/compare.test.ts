import { describe, expect, it } from "vitest";

import { compare, hostAndPath } from "./compare.js";
import { HOLE_SENTINEL } from "./library.js";

import type { UrlCase } from "./cases.js";

function urlCase(base: string | null, path: string): UrlCase {
  return {
    id: "httpx__case",
    library: "httpx",
    baseKind: "base",
    pathKind: "path",
    base,
    path,
    port: null,
    form: null,
  };
}

const get = (host: string | null, path: string | null) => ({
  method: "GET",
  host,
  path,
});

describe("hostAndPath", () => {
  it("drops the default port for the scheme and keeps any other", () => {
    expect(hostAndPath("http://api.example.com:80/orders")).toEqual({
      host: "api.example.com",
      path: "/orders",
    });
    expect(hostAndPath("https://api.example.com:80/orders")?.host).toBe(
      "api.example.com:80",
    );
  });

  it("reads a scheme-relative URL and leaves dot segments as written", () => {
    expect(hostAndPath("//other.example.com/v1/../orders")).toEqual({
      host: "other.example.com",
      path: "/v1/../orders",
    });
  });

  it("writes the library's hole as an unnamed hole and an empty path as /", () => {
    expect(
      hostAndPath(`https://api.example.com/orders/${HOLE_SENTINEL}?x=1`)?.path,
    ).toBe("/orders/{}");
    expect(hostAndPath("https://api.example.com")?.path).toBe("/");
  });
});

describe("compare", () => {
  const library = {
    kind: "url",
    url: "https://api.example.com/v1/orders",
  } as const;

  it("agrees when the host and the path match, whatever a hole is called", () => {
    const holed = {
      kind: "url",
      url: `https://api.example.com/orders/${HOLE_SENTINEL}`,
    } as const;
    expect(
      compare(urlCase(null, ""), holed, [
        get("api.example.com", "/orders/{id}"),
      ]).disagreement,
    ).toBeNull();
  });

  it("names what differs", () => {
    const c = urlCase("https://api.example.com/v1", "orders");
    expect(
      compare(c, library, [get("api.example.com", "/orders")]).disagreement,
    ).toBe("the path differs");
    expect(compare(c, library, [get(null, "/v1/orders")]).disagreement).toBe(
      "suss leaves out the host",
    );
    expect(compare(c, library, []).disagreement).toBe(
      "suss does not record a request",
    );
  });

  it("agrees with a refused base only when suss leaves the base out", () => {
    const refused = {
      kind: "refused",
      reason: "no slash",
      base: true,
    } as const;
    const c = urlCase("https://api.example.com/v1", "orders");
    expect(compare(c, refused, [get(null, "orders")]).disagreement).toBeNull();
    expect(compare(c, refused, [get(null, "/v1/orders")]).disagreement).toBe(
      "suss joins a base the library refuses",
    );
    expect(
      compare(c, refused, [get("api.example.com", "/v1/orders")]).disagreement,
    ).toBe("suss joins a base the library refuses");
    const full = urlCase(
      "https://api.example.com/v1",
      "https://other.example.com/x",
    );
    expect(
      compare(full, refused, [get("other.example.com", "/x")]).disagreement,
    ).toBeNull();
  });

  it("agrees with a refused call only when suss records no path", () => {
    const refused = {
      kind: "refused",
      reason: "empty path",
      base: false,
    } as const;
    const c = urlCase(null, "");
    expect(
      compare(c, refused, [get("api.example.com", null)]).disagreement,
    ).toBeNull();
    expect(
      compare(c, refused, [get("api.example.com", "/")]).disagreement,
    ).toBe("suss records a request the library refuses to send");
  });
});
