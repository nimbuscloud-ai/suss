import { describe, expect, it } from "vitest";

import { hostOf, isLocalUrl, pathOf, routePatternOf } from "./routePath.js";
import { constant, hole, holePiece, string, text, textPiece } from "./value.js";

describe("routePatternOf", () => {
  it("keeps the ? that marks an optional parameter", () => {
    expect(routePatternOf(text("/:pk/:filename?"))).toBe("/:pk/:filename?");
    expect(
      routePatternOf(string([holePiece("base"), textPiece(["/:id?/raw"])])),
    ).toBe("{base}/:id?/raw");
  });

  it("reads everything else the way pathOf does", () => {
    expect(routePatternOf(text("https://api.example.com/users"))).toBe(
      "/users",
    );
    expect(routePatternOf(text(""))).toBeUndefined();
    expect(routePatternOf(constant(404))).toBeUndefined();
  });
});

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

  it("finds no path when a hole hides the authority behind a scheme", () => {
    expect(
      pathOf(string([holePiece("scheme"), textPiece([":"]), holePiece("url")])),
    ).toBeUndefined();
    expect(
      pathOf(
        string([
          holePiece("host"),
          textPiece([":"]),
          holePiece("port"),
          textPiece(["/health"]),
        ]),
      ),
    ).toBe("/health");
  });

  it("keeps a colon later in a path", () => {
    expect(
      pathOf(
        string([
          textPiece(["/operations/"]),
          holePiece("id"),
          textPiece([":cancel"]),
        ]),
      ),
    ).toBe("/operations/{id}:cancel");
  });
});

describe("hostOf", () => {
  it("reads the host and port of an absolute URL", () => {
    expect(hostOf(text("https://API.Example.com/users?q=1"))).toBe(
      "api.example.com",
    );
    expect(hostOf(text("http://localhost:3000/users"))).toBe("localhost:3000");
    expect(hostOf(text("//cdn.example.org/a.js"))).toBe("cdn.example.org");
  });

  it("reads the host by hand when the URL parser rejects the text", () => {
    expect(hostOf(text("https://bad host.example.com/x"))).toBe(
      "bad host.example.com",
    );
    expect(hostOf(text("https://"))).toBeUndefined();
  });

  it("leaves out the user and password", () => {
    expect(hostOf(text("https://user:secret@db.example.com/x"))).toBe(
      "db.example.com",
    );
  });

  it("has no host for a relative URL or a local one", () => {
    expect(hostOf(text("/users"))).toBeUndefined();
    expect(hostOf(text("users/1"))).toBeUndefined();
    expect(hostOf(text("data:text/plain,hi"))).toBeUndefined();
    expect(hostOf(constant(1))).toBeUndefined();
  });

  it("writes a piece of the authority it could not read as a hole", () => {
    expect(
      hostOf(
        string([
          textPiece(["https://"]),
          holePiece("tenant"),
          textPiece([".example.com/orders/"]),
          holePiece("id"),
        ]),
      ),
    ).toBe("{tenant}.example.com");
    expect(
      hostOf(string([holePiece("base"), textPiece(["/orders"])])),
    ).toBeUndefined();
    expect(
      hostOf(string([holePiece("scheme"), textPiece([":"]), holePiece("url")])),
    ).toBe("{scheme}:{url}");
  });

  it("reads a literal host written before a hole in the path", () => {
    expect(
      hostOf(
        string([
          textPiece(["https://www.example.net/search?q="]),
          holePiece("q"),
        ]),
      ),
    ).toBe("www.example.net");
  });
});
