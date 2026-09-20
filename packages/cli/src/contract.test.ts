// contract.test.ts: `suss contract` CLI command tests

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { contract } from "./contract.js";
import { runCli } from "./run.js";

import type { AddressInfo } from "node:net";
import type { BehavioralSummary } from "@suss/behavioral-ir";

/** What the command wrote, and what it gave back to the shell. */
async function capture(
  args: string[],
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    out.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  let exit: number;
  try {
    exit = await runCli(args);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { exit, stdout: out.join(""), stderr: err.join("") };
}

const minimalSpec = {
  openapi: "3.0.3",
  info: { title: "contract-cli-test", version: "1.0.0" },
  paths: {
    "/users/{id}": {
      get: {
        operationId: "getUser",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { id: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
};

describe("contract CLI command", () => {
  let tmpDir: string;
  let specFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-contract-cli-"));
    specFile = path.join(tmpDir, "spec.json");
    fs.writeFileSync(specFile, JSON.stringify(minimalSpec));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("returns summaries from an OpenAPI spec via --from openapi", async () => {
    const writeFn = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    let summaries: BehavioralSummary[];
    try {
      summaries = await contract({ from: "openapi", spec: specFile });
    } finally {
      process.stdout.write = writeFn;
    }
    expect(summaries).toHaveLength(1);
    expect(summaries[0].kind).toBe("handler");
    expect(summaries[0].identity.name).toBe("getUser");
    expect(summaries[0].confidence).toEqual({
      source: "derived",
      level: "high",
    });
  });

  it("reads a Terraform module via --from terraform, with the AWS pack loaded", async () => {
    const moduleDir = path.join(tmpDir, "infra");
    fs.mkdirSync(moduleDir);
    fs.writeFileSync(
      path.join(moduleDir, "main.tf"),
      [
        'resource "aws_dynamodb_table" "orders" {',
        '  name     = "${local.environment}-orders-v1"',
        '  hash_key = "order_id"',
        "}",
      ].join("\n"),
    );

    const writeFn = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    let summaries: BehavioralSummary[];
    try {
      summaries = await contract({ from: "terraform", spec: moduleDir });
    } finally {
      process.stdout.write = writeFn;
    }

    expect(summaries).toHaveLength(1);
    expect(summaries[0].identity.name).toBe("aws_dynamodb_table.orders");
    expect(summaries[0].identity.boundaryBinding?.semantics).toMatchObject({
      name: "storage",
      storageSystem: "aws.dynamodb",
      container: "orders",
    });
  });

  it("gives a Terraform unit the code scope the caller states", async () => {
    const moduleDir = path.join(tmpDir, "infra-scoped");
    fs.mkdirSync(moduleDir);
    fs.writeFileSync(
      path.join(moduleDir, "main.tf"),
      [
        'resource "aws_lambda_function" "confirm" {',
        '  function_name = "confirm"',
        '  handler       = "index.handler"',
        "}",
      ].join("\n"),
    );

    const writeFn = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    let summaries: BehavioralSummary[];
    try {
      summaries = await contract({
        from: "terraform",
        spec: moduleDir,
        codeScopes: { confirm: "services/orders" },
      });
    } finally {
      process.stdout.write = writeFn;
    }

    expect(summaries[0].metadata?.codeScope).toEqual({
      kind: "codeUri",
      path: "services/orders",
      entry: "index",
    });
  });

  it("takes a --code-scope per unit at the command line", async () => {
    const moduleDir = path.join(tmpDir, "infra-flag");
    fs.mkdirSync(moduleDir);
    fs.writeFileSync(
      path.join(moduleDir, "main.tf"),
      [
        'resource "aws_lambda_function" "confirm" {',
        '  function_name = "confirm"',
        "}",
        'resource "aws_lambda_function" "settle" {',
        '  function_name = "settle"',
        "}",
      ].join("\n"),
    );

    const { exit, stdout } = await capture([
      "contract",
      "--from",
      "terraform",
      moduleDir,
      "--code-scope",
      "confirm=services/orders",
      "--code-scope",
      "settle=services/billing",
    ]);

    expect(exit).toBe(0);
    const scopes = (JSON.parse(stdout) as BehavioralSummary[]).map(
      (summary) => summary.metadata?.codeScope,
    );
    expect(scopes).toEqual([
      { kind: "codeUri", path: "services/orders" },
      { kind: "codeUri", path: "services/billing" },
    ]);
  });

  it("says how to write a --code-scope that has no directory in it", async () => {
    const { exit, stderr } = await capture([
      "contract",
      "--from",
      "terraform",
      tmpDir,
      "--code-scope",
      "api/web",
    ]);

    expect(exit).toBe(1);
    expect(stderr).toContain("--code-scope takes a unit and the directory");
  });

  it("writes summaries to the output file when -o is given", async () => {
    const outFile = path.join(tmpDir, "out.json");
    const writeErr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await contract({ from: "openapi", spec: specFile, output: outFile });
    } finally {
      process.stderr.write = writeErr;
    }
    expect(fs.existsSync(outFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(outFile, "utf8"));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });

  it("rejects an unknown --from value", async () => {
    await expect(
      contract({
        // Cast to bypass the ContractSource literal type guard; this is what an
        // unknown CLI argument would look like at runtime.
        from: "no-such-source" as unknown as "openapi",
        spec: specFile,
      }),
    ).rejects.toThrow(/Unknown contract source/);
  });

  it("emits story summaries from a Storybook CSF file via --from storybook", async () => {
    const storiesFile = path.resolve(
      __dirname,
      "../../../fixtures/storybook/Button.stories.tsx",
    );
    const out: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const summaries = await contract({
        from: "storybook",
        spec: storiesFile,
      });
      expect(summaries.length).toBeGreaterThan(0);
      const names = summaries.map((s) => s.identity.name).sort();
      expect(names).toContain("Button.Primary");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it("walks a directory for `.stories.ts[x]` files when --from storybook targets a dir", async () => {
    const storiesDir = path.resolve(__dirname, "../../../fixtures/storybook");
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const summaries = await contract({ from: "storybook", spec: storiesDir });
      // Multiple story files in the directory, expect multiple
      // component prefixes in the output.
      const components = new Set(
        summaries.map(
          (s) =>
            (
              s.metadata?.component as
                | { storybook?: { component?: string } }
                | undefined
            )?.storybook?.component,
        ),
      );
      expect(components.size).toBeGreaterThan(1);
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it("recurses into subdirectories when --from storybook targets a dir tree", async () => {
    const fixtureStory = fs.readFileSync(
      path.resolve(__dirname, "../../../fixtures/storybook/Button.stories.tsx"),
      "utf8",
    );
    const nested = path.join(tmpDir, "components", "ui");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "Button.stories.tsx"), fixtureStory);
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const summaries = await contract({ from: "storybook", spec: tmpDir });
      expect(summaries.length).toBeGreaterThan(0);
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it("rejects a storybook spec path that doesn't exist", async () => {
    await expect(
      contract({ from: "storybook", spec: "/nonexistent/Stories.tsx" }),
    ).rejects.toThrow(/No stories found/);
  });

  it("emits operation summaries from a documents dir via --from graphql-documents", async () => {
    const docsDir = path.resolve(
      __dirname,
      "../../../fixtures/graphql-documents",
    );
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const summaries = await contract({
        from: "graphql-documents",
        spec: docsDir,
      });
      expect(summaries.length).toBeGreaterThan(0);
      expect(summaries.every((s) => s.kind === "client")).toBe(true);
      const productList = summaries.find(
        (s) => s.identity.name === "ProductList",
      );
      expect(productList?.identity.boundaryBinding?.semantics).toEqual({
        name: "graphql-operation",
        operationType: "query",
        operationName: "ProductList",
      });
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it("reads a Serverless Framework service via --from serverless", async () => {
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const summaries = await contract({
        from: "serverless",
        spec: path.resolve(
          __dirname,
          "../../../fixtures/serverless/serverless.yml",
        ),
      });
      const units = summaries
        .map((s) => s.identity.deployableUnit?.instanceName)
        .filter((name) => name !== undefined);
      expect(units).toEqual(
        expect.arrayContaining(["createOrder", "processOrders"]),
      );
    } finally {
      process.stdout.write = origWrite;
    }
  });

  describe("URL inputs", () => {
    let server: http.Server;
    let baseUrl: string;
    // The server serves the same minimalSpec under several path shapes so
    // each test can exercise content-type / extension routing.
    const routes = new Map<string, { body: string; contentType: string }>([
      [
        "/spec.json",
        { body: JSON.stringify(minimalSpec), contentType: "application/json" },
      ],
      [
        "/spec.yaml",
        {
          body: [
            "openapi: 3.0.3",
            "info:",
            "  title: contract-cli-test",
            "  version: 1.0.0",
            "paths:",
            "  /users/{id}:",
            "    get:",
            "      operationId: getUser",
            "      parameters:",
            "        - name: id",
            "          in: path",
            "          required: true",
            "          schema:",
            "            type: string",
            "      responses:",
            "        '200':",
            "          description: ok",
            "          content:",
            "            application/json:",
            "              schema:",
            "                type: object",
            "                properties:",
            "                  id:",
            "                    type: string",
            "",
          ].join("\n"),
          contentType: "application/yaml",
        },
      ],
    ]);

    beforeEach(async () => {
      server = http.createServer((req, res) => {
        const url = req.url ?? "/";
        const route = routes.get(url);
        if (route === undefined) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        res.setHeader("content-type", route.contentType);
        res.end(route.body);
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    });

    it("fetches a JSON spec from a URL via --from openapi", async () => {
      const writeFn = process.stdout.write;
      process.stdout.write = (() => true) as typeof process.stdout.write;
      let summaries: BehavioralSummary[];
      try {
        summaries = await contract({
          from: "openapi",
          spec: `${baseUrl}/spec.json`,
        });
      } finally {
        process.stdout.write = writeFn;
      }
      expect(summaries).toHaveLength(1);
      expect(summaries[0].identity.name).toBe("getUser");
    });

    it("fetches a YAML spec from a URL and routes it through the YAML parser by extension", async () => {
      const writeFn = process.stdout.write;
      process.stdout.write = (() => true) as typeof process.stdout.write;
      let summaries: BehavioralSummary[];
      try {
        summaries = await contract({
          from: "openapi",
          spec: `${baseUrl}/spec.yaml`,
        });
      } finally {
        process.stdout.write = writeFn;
      }
      expect(summaries).toHaveLength(1);
      expect(summaries[0].identity.name).toBe("getUser");
    });

    it("surfaces a useful error when the URL returns a non-2xx status", async () => {
      await expect(
        contract({ from: "openapi", spec: `${baseUrl}/missing.yaml` }),
      ).rejects.toThrow(/Failed to fetch contract.*404/);
    });
  });
});

describe("contract --from wrangler", () => {
  let workerDir: string;

  beforeEach(() => {
    workerDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-wrangler-cli-"));
    fs.writeFileSync(
      path.join(workerDir, "wrangler.toml"),
      `name = "greeting-router"
main = "src/index.ts"

[vars]
GREETING_TABLE = "prod-greetings-v2"

[[queues.consumers]]
queue = "greeting-events"
`,
    );
  });

  afterEach(() => {
    fs.rmSync(workerDir, { recursive: true });
  });

  it("reads a Worker's configuration from the directory it is in", async () => {
    const out = path.join(workerDir, "summaries.json");
    const summaries = await contract({
      from: "wrangler",
      spec: workerDir,
      output: out,
    });
    expect(
      summaries.map((s) => s.identity.boundaryBinding?.semantics.name).sort(),
    ).toEqual(["message-bus", "runtime-config"]);
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toHaveLength(2);
  });
});
