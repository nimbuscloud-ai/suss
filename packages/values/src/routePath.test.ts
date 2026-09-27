import { describe, expect, it } from "vitest";

import { isLocalUrl, pathOf } from "./routePath.js";
import { constant, hole, holePiece, string, text, textPiece } from "./value.js";

describe("pathOf on one literal", () => {
  it("keeps a plain path as written", () => {
    expect(pathOf(text("/users/list"))).toBe("/users/list");
  });

  it("drops the origin of an absolute URL", () => {
    expect(pathOf(text("https://api.example.com/users?page=2#top"))).toBe(
      "/users",
    );
  });

  it("drops the origin of a protocol-relative URL", () => {
    expect(pathOf(text("//api.example.com/users"))).toBe("/users");
  });

  it("strips an origin the URL parser rejects", () => {
    expect(pathOf(text("https://"))).toBeUndefined();
    expect(pathOf(text("//"))).toBeUndefined();
  });

  it("ends the path where the query starts", () => {
    expect(pathOf(text("/users?page=2"))).toBe("/users");
    expect(pathOf(text("/users#top"))).toBe("/users");
  });

  it("gives undefined for an empty path", () => {
    expect(pathOf(text(""))).toBeUndefined();
    expect(pathOf(text("?page=2"))).toBeUndefined();
  });

  it("gives undefined for a value that is not a string", () => {
    expect(pathOf(constant(404))).toBeUndefined();
    expect(pathOf(hole("route"))).toBeUndefined();
  });

  it("gives undefined for a URL fetch reads without a request", () => {
    expect(pathOf(text("data:image/svg+xml;base64,PHN2Zz4="))).toBeUndefined();
    expect(pathOf(text("blob:https://app.example.com/1f2e"))).toBeUndefined();
    expect(pathOf(text("about:blank"))).toBeUndefined();
  });
});

describe("isLocalUrl", () => {
  it("is true for a local scheme, whatever its case", () => {
    expect(isLocalUrl(text("data:text/plain,hi"))).toBe(true);
    expect(isLocalUrl(text("DATA:text/plain,hi"))).toBe(true);
  });

  it("is true when the text before a hole starts with a local scheme", () => {
    expect(
      isLocalUrl(
        string([textPiece(["data:image/png;base64,"]), holePiece("b64")]),
      ),
    ).toBe(true);
  });

  it("is false for a network URL, a path, a hole and a non-string", () => {
    expect(isLocalUrl(text("https://api.example.com/data:x"))).toBe(false);
    expect(isLocalUrl(text("/data:export"))).toBe(false);
    expect(isLocalUrl(string([holePiece("base"), textPiece(["data:"])]))).toBe(
      false,
    );
    expect(isLocalUrl(constant(1))).toBe(false);
  });
});

describe("pathOf on a string with holes", () => {
  it("spells a hole by its name", () => {
    expect(pathOf(string([textPiece(["/pet/"]), holePiece("id")]))).toBe(
      "/pet/{id}",
    );
  });

  it("spells a hole with the segments it takes", () => {
    expect(
      pathOf(string([textPiece(["/files/"]), holePiece("rest", "any")])),
    ).toBe("/files/{rest*}");
  });

  it("spells a piece that is one of a few texts as a set", () => {
    expect(
      pathOf(string([textPiece(["/api/"]), textPiece(["v1", "v2"])])),
    ).toBe("/api/(v1|v2)");
  });

  it("spells a set an option of which cannot be read back as a hole", () => {
    expect(
      pathOf(string([textPiece(["/api/"]), textPiece(["v1", "v2?x"])])),
    ).toBe("/api/{value}");
  });

  it("leaves a hole inside the authority out of the path", () => {
    expect(
      pathOf(
        string([
          textPiece(["https://"]),
          holePiece("host"),
          textPiece(["/users/"]),
          holePiece("id"),
        ]),
      ),
    ).toBe("/users/{id}");
  });

  it("treats a hole standing for the whole origin as the authority", () => {
    expect(
      pathOf(string([holePiece("base"), textPiece(["://host/users"])])),
    ).toBe("/users");
  });

  it("gives undefined when the authority never ends", () => {
    expect(
      pathOf(string([textPiece(["https://"]), holePiece("host")])),
    ).toBeUndefined();
  });

  it("leaves a hole after the query out of the path", () => {
    expect(
      pathOf(string([textPiece(["/users?page="]), holePiece("page")])),
    ).toBe("/users");
  });
});
