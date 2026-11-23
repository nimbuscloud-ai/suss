import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { extractRubyProject } from "@suss/adapter-ruby";

import { NET_HTTP, NET_HTTP_CONNECTION, netHttpClient } from "./index.js";

import type { BehavioralSummary, Predicate } from "@suss/behavioral-ir";

let projectDir: string | null = null;

afterEach(() => {
  if (projectDir !== null) {
    fs.rmSync(projectDir, { recursive: true, force: true });
    projectDir = null;
  }
});

/**
 * The summaries of one file, read the way a run reads a project, so the
 * value facts a name resolves through are the ones a project has.
 */
async function summariesOf(source: string): Promise<BehavioralSummary[]> {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-net-http-"));
  const file = path.join(projectDir, "order_client.rb");
  fs.writeFileSync(file, source);
  const { summaries } = await extractRubyProject({
    files: [file],
    packs: [netHttpClient()],
    workspaceRoot: projectDir,
    cacheDir: null,
  });
  return summaries.filter((summary) => summary.kind === "client");
}

/** The method and path of the first client summary. */
function boundary(summaries: BehavioralSummary[]): {
  method: string | null;
  path: string | null;
} {
  const semantics = summaries[0]?.identity.boundaryBinding?.semantics;
  if (semantics?.name !== "rest") {
    throw new Error(
      `expected a REST boundary, got ${JSON.stringify(semantics)}`,
    );
  }
  return { method: semantics.method, path: semantics.path };
}

/** The method, host and path of the first client summary, as one string. */
async function requestIn(lines: string[]): Promise<string> {
  const summaries = await summariesOf(
    ["class OrderClient", "  def fetch", ...lines, "  end", "end"].join("\n"),
  );
  const semantics = summaries[0]?.identity.boundaryBinding?.semantics;
  if (semantics?.name !== "rest") {
    throw new Error(
      `expected a REST boundary, got ${JSON.stringify(semantics)}`,
    );
  }
  return `${semantics.method} ${semantics.host ?? ""}${semantics.path}`;
}

describe("a method that calls Net::HTTP", () => {
  it("reads the URL a call wraps in URI", async () => {
    const summaries = await summariesOf(
      [
        "class OrderClient",
        "  def fetch",
        '    Net::HTTP.get(URI("https://api.example.com/orders"))',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(summaries).toHaveLength(1);
    expect(boundary(summaries)).toEqual({ method: "GET", path: "/orders" });
  });

  it("reads a URI held in a local, written with parse", async () => {
    const summaries = await summariesOf(
      [
        "class OrderClient",
        "  def fetch(id)",
        '    uri = URI.parse("https://api.example.com/orders/#{id}")',
        "    Net::HTTP.get_response(uri)",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(boundary(summaries)).toEqual({
      method: "GET",
      path: "/orders/{id}",
    });
  });

  it("reads the method a posted form sends", async () => {
    const summaries = await summariesOf(
      [
        "class OrderClient",
        "  def create(params)",
        '    Net::HTTP.post_form(URI("https://api.example.com/orders"), params)',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(boundary(summaries)).toEqual({ method: "POST", path: "/orders" });
  });

  it("reads a request object built in several steps", async () => {
    const summaries = await summariesOf(
      [
        "class OrderClient",
        "  def create(body)",
        '    uri = URI("https://api.example.com/orders")',
        "    http = Net::HTTP.new(uri.host, uri.port)",
        "    request = Net::HTTP::Post.new(uri)",
        "    request.body = body",
        "    http.request(request)",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(boundary(summaries)).toEqual({ method: "POST", path: "/orders" });
  });

  it("reads a request object built in the call itself", async () => {
    const summaries = await summariesOf(
      [
        "class OrderClient",
        "  def drop(id)",
        '    uri = URI("https://api.example.com/orders/#{id}")',
        "    http = Net::HTTP.new(uri.host, uri.port)",
        "    http.request(Net::HTTP::Delete.new(uri))",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(boundary(summaries)).toEqual({
      method: "DELETE",
      path: "/orders/{id}",
    });
  });

  it("says nothing about a request class the library does not define", async () => {
    const summaries = await summariesOf(
      [
        "class OrderClient",
        "  def send_it",
        '    uri = URI("https://api.example.com/orders")',
        "    http = Net::HTTP.new(uri.host, uri.port)",
        "    http.request(OurOwn::Request.new(uri))",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(summaries).toEqual([]);
  });

  it("is a client with no path for a URL that does not settle on a string", async () => {
    const summaries = await summariesOf(
      [
        "class OrderClient",
        "  def fetch(target)",
        "    Net::HTTP.get(URI(target))",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(summaries).toHaveLength(1);
    expect(boundary(summaries)).toEqual({ method: "GET", path: null });
  });

  it("keeps each request with no path that one method sends", async () => {
    const root = path.resolve(
      __dirname,
      "../../../../fixtures/wrapper-request-method-ruby",
    );
    const { summaries } = await extractRubyProject({
      files: [path.join(root, "app/http_client.rb")],
      packs: [netHttpClient()],
      workspaceRoot: root,
      cacheDir: null,
    });
    const requests = summaries.flatMap((summary) => {
      const semantics = summary.identity.boundaryBinding?.semantics;
      return summary.kind === "client" && semantics?.name === "rest"
        ? [`${semantics.method} ${semantics.path}`]
        : [];
    });

    expect(requests).toEqual(["GET null", "DELETE null", "POST null"]);
  });

  it("says which verb picks each request when a case on the verb picks one", async () => {
    const root = path.resolve(
      __dirname,
      "../../../../fixtures/wrapper-request-method-ruby",
    );
    const { summaries } = await extractRubyProject({
      files: [path.join(root, "app/http_client.rb")],
      packs: [netHttpClient()],
      workspaceRoot: root,
      cacheDir: null,
    });
    const picked = summaries.flatMap((summary) => {
      const semantics = summary.identity.boundaryBinding?.semantics;
      return summary.kind === "client" && semantics?.name === "rest"
        ? [[semantics.method, summary.bindingFrom?.when]]
        : [];
    });
    const methodIs = (value: string) => [
      {
        type: "comparison",
        left: { type: "input", inputRef: "method", path: [] },
        op: "eq",
        right: { type: "literal", value },
      },
    ];

    expect(picked).toEqual([
      ["GET", methodIs("get")],
      ["DELETE", methodIs("delete")],
      ["POST", methodIs("post")],
    ]);
  });
});

describe("a helper that takes the method from its caller", () => {
  const root = path.resolve(
    __dirname,
    "../../../../fixtures/request-method-parameter-ruby",
  );

  async function fixtureSummaries(): Promise<BehavioralSummary[]> {
    const { summaries } = await extractRubyProject({
      files: ["app/http_client.rb", "app/grants.rb", "bin/sync_grants.rb"].map(
        (file) => path.join(root, file),
      ),
      packs: [netHttpClient()],
      workspaceRoot: root,
      cacheDir: null,
    });
    return summaries;
  }

  /** Whether a condition on `input` is true when the input is `value`. */
  function holdsWith(predicate: Predicate, input: string, value: unknown) {
    if (predicate.type === "negation") {
      return !holdsWith(predicate.operand, input, value);
    }
    if (
      predicate.type !== "comparison" ||
      predicate.left.type !== "input" ||
      predicate.left.inputRef !== input ||
      predicate.right.type !== "literal"
    ) {
      throw new Error(`unexpected condition ${JSON.stringify(predicate)}`);
    }
    return predicate.right.value === value;
  }

  it("says which value of the parameter picks each request, and the parameter's default", async () => {
    const clients = (await fixtureSummaries()).filter(
      (summary) =>
        summary.kind === "client" && summary.identity.name === "fetch",
    );

    expect(clients).toHaveLength(3);
    for (const client of clients) {
      expect(client.inputs[1]).toMatchObject({
        name: "method",
        position: 1,
        default: { type: "literal", value: "get" },
      });
    }
    const picked = (value: string) =>
      clients
        .filter((client) =>
          (client.bindingFrom?.when ?? []).every((one) =>
            holdsWith(one, "method", value),
          ),
        )
        .map((client) => {
          const semantics = client.identity.boundaryBinding?.semantics;
          return semantics?.name === "rest" ? semantics.method : null;
        });
    expect([picked("get"), picked("delete"), picked("post")]).toEqual([
      ["GET"],
      ["DELETE"],
      ["POST"],
    ]);
  });

  it("gives every caller's call a method from its argument or the default", async () => {
    const summaries = await fixtureSummaries();
    const fetch = summaries.find(
      (summary) =>
        summary.identity.id === "app/http_client.rb::HttpClient.fetch",
    );
    const fallback = fetch?.inputs[1];
    const sent = summaries
      .filter((summary) => summary.location.file === "app/grants.rb")
      .flatMap((caller) =>
        caller.transitions.flatMap((transition) =>
          transition.effects.flatMap((effect) =>
            effect.type === "invocation" &&
            effect.summary === fetch?.identity.id
              ? [[caller.identity.name, effect.args[1]]]
              : [],
          ),
        ),
      )
      .map(([caller, passed]) => [
        caller,
        passed === undefined && fallback?.type === "parameter"
          ? fallback.default
          : passed,
      ]);

    expect(sent).toEqual([
      ["list", { type: "literal", value: "get" }],
      ["create", { kind: "string", value: "post" }],
      ["revoke", { kind: "string", value: "delete" }],
    ]);
  });

  it("reads send_request, whose method the helper's caller passes", async () => {
    const helper = (await fixtureSummaries()).find(
      (summary) =>
        summary.kind === "client" && summary.identity.name === "send_raw",
    );

    expect(helper?.identity.boundaryBinding?.semantics).toEqual({
      name: "rest",
      method: null,
      path: null,
      host: "api.example.com:443",
    });
    expect(helper?.bindingFrom).toEqual({
      method: [{ type: "input", inputRef: "verb", path: [] }],
    });
    expect(helper?.inputs[1]).toMatchObject({
      name: "verb",
      default: { type: "literal", value: "GET" },
    });
  });
});

describe("a host and a path given apart", () => {
  it("reads the host, the path and the port of a get method", async () => {
    expect(
      await requestIn([
        '    Net::HTTP.get("api.example.com", "/orders", 8080)',
      ]),
    ).toBe("GET api.example.com:8080/orders");
    expect(
      await requestIn([
        '    Net::HTTP.get_response("api.example.com", "/orders")',
      ]),
    ).toBe("GET api.example.com/orders");
    expect(
      await requestIn([
        '    Net::HTTP.get_print("api.example.com", "/orders", 80)',
      ]),
    ).toBe("GET api.example.com/orders");
  });

  it("reads a host and a port kept in constants", async () => {
    const summaries = await summariesOf(
      [
        'DEBUG_HOST = ENV["DEBUG_HOST"] || "127.0.0.1"',
        "DEBUG_PORT = 9222",
        "class OrderClient",
        "  def fetch",
        '    Net::HTTP.get(DEBUG_HOST, "/json/list", DEBUG_PORT)',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(summaries[0]?.identity.boundaryBinding?.semantics).toMatchObject({
      method: "GET",
      path: "/json/list",
      host: "127.0.0.1:9222",
    });
  });

  it("reads the first argument as the URL when the second is a hash of headers", async () => {
    expect(
      await requestIn([
        "    headers = {}",
        '    Net::HTTP.get(URI("https://cdn.example.com/assets/app.css"), headers)',
      ]),
    ).toBe("GET cdn.example.com/assets/app.css");
    expect(
      await requestIn([
        '    Net::HTTP.get(URI("https://cdn.example.com/assets/app.css"), { "Accept" => "text/css" })',
      ]),
    ).toBe("GET cdn.example.com/assets/app.css");
  });

  it("goes to the host of a full URL passed as the path", async () => {
    expect(
      await requestIn([
        '    Net::HTTP.get("api.example.com", "https://other.example.com/orders")',
      ]),
    ).toBe("GET other.example.com/orders");
  });

  it("reads a host-first call on a connection as a path and its headers", async () => {
    expect(
      await requestIn([
        '    http = Net::HTTP.new("api.example.com")',
        '    http.get("/orders", "/ignored")',
      ]),
    ).toBe("GET api.example.com/orders");
  });

  it("leaves out a path that does not start with a slash, which Net::HTTP sends as written", async () => {
    const summaries = await summariesOf(
      [
        "class OrderClient",
        "  def fetch",
        '    http = Net::HTTP.new("api.example.com")',
        '    http.get("orders")',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(boundary(summaries)).toEqual({ method: "GET", path: null });
  });

  it("leaves out a host that is written as a URL", async () => {
    expect(
      await requestIn([
        '    http = Net::HTTP.new("https://api.example.com")',
        '    http.get("/orders")',
      ]),
    ).toBe("GET /orders");
    expect(
      await requestIn(['    Net::HTTP.get("api.example.com/", "/orders")']),
    ).toBe("GET /orders");
  });

  it("sends a connection's path as written, dot segments and all", async () => {
    expect(
      await requestIn([
        '    http = Net::HTTP.new("api.example.com")',
        '    http.get("/v2/../orders")',
      ]),
    ).toBe("GET api.example.com/v2/../orders");
  });

  it("sends a connection's calls to the host and port it was built on", async () => {
    expect(
      await requestIn([
        '    http = Net::HTTP.new("api.example.com")',
        '    http.get("/orders")',
      ]),
    ).toBe("GET api.example.com/orders");
    expect(
      await requestIn([
        '    http = Net::HTTP.new("api.example.com", 8443)',
        '    http.request(Net::HTTP::Get.new("/orders"))',
      ]),
    ).toBe("GET api.example.com:8443/orders");
  });
});

describe("what a caller does with the response", () => {
  it("reads a status the caller converts before it tests it", async () => {
    const summaries = await summariesOf(
      [
        "class OrderClient",
        "  def fetch(id)",
        '    response = Net::HTTP.get_response(URI("https://api.example.com/orders/#{id}"))',
        "    return nil if response.code.to_i == 404",
        "",
        "    response.body",
        "  end",
        "end",
      ].join("\n"),
    );

    const http = summaries[0]?.metadata?.http as
      | { statusAccessors?: string[] }
      | undefined;
    expect(http?.statusAccessors).toEqual(["code"]);
    // The summary records the condition as structure, so the member
    // and the literal can be read off it.
    expect(summaries[0]?.transitions[0]?.conditions[0]).toMatchObject({
      type: "comparison",
      left: { type: "dependency", accessChain: ["code"] },
      right: { value: 404 },
    });
  });
});

describe("the declarations' examples", () => {
  it("make the method each is written in a client", async () => {
    expect(await requestIn([`    ${NET_HTTP.declared.example}`])).toBe(
      "GET api.example.com/orders",
    );
    expect(
      await requestIn([`    ${NET_HTTP_CONNECTION.declared.example}`]),
    ).toBe("GET api.example.com/orders");
  });
});
