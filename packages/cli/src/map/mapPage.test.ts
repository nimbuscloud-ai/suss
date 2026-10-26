import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  envRead,
  modelOf,
  opaque,
  resolver,
  rest,
  tableAccess,
  transition,
  unit,
} from "../__fixtures__/mapSummaries.js";
import { CARD_RULES, pickCards } from "./mapCards.js";
import { renderMapPage } from "./mapPage.js";
import {
  FINDINGS_LISTED_IN_ALL,
  FINDINGS_LISTED_PER_KIND,
} from "./mapPageData.js";

import type { Card } from "./mapCards.js";
import type { MapModel } from "./mapModel.js";

function route(path: string, method = "GET") {
  return unit({
    kind: "handler",
    file: "src/routes.ts",
    name: `${method}${path}`,
    line: 10,
    binding: rest(method, path),
    transitions: [
      transition(`${path}:200`, {
        status: 200,
        effects: [
          tableAccess("write", "audit", "audit.insert", 12),
          tableAccess("write", "orders", "orders.insert"),
          tableAccess("write", "items", "items.insert"),
          envRead("REGION", false),
        ],
      }),
      transition("requireUser:302", {
        status: 302,
        conditions: [opaque("!user")],
        wrapper: "requireUser",
      }),
    ],
    gaps: [
      {
        type: "unreadOutcome",
        conditions: [],
        consequence: "unknown",
        description: "no pack read this",
      },
    ],
  });
}

function field(name: string) {
  return unit({
    kind: "resolver",
    file: "src/schema.ts",
    name: `Query.${name}`,
    binding: resolver("Query", name),
  });
}

/** A model where every card kind has something to show. */
function everyCard(): MapModel {
  const model = modelOf([
    ...["/a", "/b", "/c", "/d", "/e"].map((p) => route(p)),
    field("orders"),
    field("order"),
  ]);
  const orders = model.entries.findIndex((entry) => entry.path === "orders");
  (model.entries[orders] as MapModel["entries"][number]).callers = [0];
  model.findings = [
    {
      kind: "unhandledProviderCase",
      severity: "warning",
      description:
        "Provider produces status 404 but no consumer branch handles it",
      entry: 0,
      provider: { unit: 0, line: 12 },
      consumer: { unit: 1, line: null },
    },
  ];
  return model;
}

function render(model: MapModel, cards: readonly Card[] = pickCards(model)) {
  return renderMapPage(model, cards, {
    summariesDir: ".suss/summaries",
    sourceLines: (_unit, start, end) =>
      Array.from(
        { length: end - start + 1 },
        (_, i) => `  line ${start + i} "text" 42`,
      ),
  });
}

describe("the map page", () => {
  it("draws every card kind with its name, its rule on hover, and the command behind it", () => {
    const model = everyCard();
    const cards = Object.values(CARD_RULES).flatMap((rule) => rule.pick(model));

    const html = render(model, cards);

    for (const rule of Object.values(CARD_RULES)) {
      expect(html).toContain(`>${rule.name}</span>`);
      expect(html).toContain(rule.rule.replace(/"/g, "&quot;"));
    }
    expect(html).toContain("writes 3 tables");
    expect(html).toContain("GET routes write");
    expect(html).toContain("written by 5 routes");
    expect(html).toContain('from <code class="src">requireUser</code>');
    expect(html).toContain("1 field");
    expect(html).toContain("not read");
    expect(html).toContain("suss check --dir .suss/summaries --json");
    expect(html).toContain("suss ask &quot;what writes postgresql:audit&quot;");
  });

  it("shows a finding with both sides of the code, the provider's line marked", () => {
    const model = everyCard();

    const html = render(model, CARD_RULES.finding.pick(model));

    expect(html).toContain("Provider produces status 404");
    expect(html).toContain('<span class="cl hl"><span class="ln">12</span>');
    expect(html).toContain("Called from");
  });

  it("links a line into the editor at the folder the read came from", () => {
    const html = render(everyCard());

    expect(html).toContain('href="vscode://file/work/shop/src/routes.ts:12"');
  });

  it("leaves the card list with one line when no rule matched", () => {
    const html = render(
      modelOf([unit({ kind: "library", file: "a.ts", name: "a" })]),
      [],
    );

    expect(html).toContain("No cards for this project.");
  });

  it("keeps its data from closing the script it is in", () => {
    const model = modelOf([route("/a")]);
    (model.entries[0] as MapModel["entries"][number]).path = "</script><b>";

    const html = render(model, []);

    expect(html).not.toContain("</script><b>");
    expect(html).toContain("\\u003c/script>");
  });

  it("names the frameworks and languages above the title, and counts what it found", () => {
    const html = render(everyCard());

    expect(html).toContain("<span>Express and Apollo Server</span>");
    expect(html).toContain("<span>TypeScript</span>");
    expect(html).toContain('<span class="tile-l">Routes</span>');
    expect(html).toContain('<span class="tile-l">GraphQL fields</span>');
    expect(html).toContain("Calls not followed");
  });

  it("carries its stylesheet and script inside the file", () => {
    const html = render(everyCard());

    expect(html).toMatch(/<style>[^<]*--f-ui:/);
    expect(html).toContain("The browser side of the map");
  });
});

/** A model whose first route has `count` findings of one kind, and one finding placed on no route. */
function manyFindings(count: number): MapModel {
  const model = everyCard();
  const placed = Array.from({ length: count }, (_, at) => ({
    kind: "unhandledProviderCase" as const,
    severity: "warning" as const,
    description: `Provider produces status ${400 + at} but no consumer branch handles it`,
    entry: 0,
    provider: { unit: 0, line: 12 },
    consumer: { unit: 1, line: null },
  }));
  model.findings = [
    ...placed,
    {
      kind: "providerContractViolation",
      severity: "error",
      description: "placed on no route",
      entry: null,
      provider: { unit: null, line: null },
      consumer: { unit: null, line: null },
    },
  ];
  (model.entries[0] as MapModel["entries"][number]).findings = placed.map(
    (_, at) => at,
  );
  return model;
}

function pageParts(html: string): {
  data: {
    s: string[];
    e: Array<{ f: number[]; fx: Array<[number, number]> }>;
    fi: Array<[number, number, number | null]>;
  };
  dataText: string;
  findings: unknown[][];
} {
  const dataText =
    /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(
      html,
    )?.[1] ?? "";
  const blob =
    /<script id="findings" type="application\/gzip">([\s\S]*?)<\/script>/.exec(
      html,
    )?.[1] ?? "";
  return {
    data: JSON.parse(dataText),
    dataText,
    findings: JSON.parse(gunzipSync(Buffer.from(blob, "base64")).toString()),
  };
}

describe("the map page's findings", () => {
  it("lists the first findings of each kind on a route and counts the rest", () => {
    const { data, findings } = pageParts(render(manyFindings(25), []));

    const first = data.e[0];
    expect(first?.f).toHaveLength(FINDINGS_LISTED_PER_KIND);
    expect(first?.fx.map(([kind, more]) => [data.s[kind], more])).toEqual([
      ["unhandledProviderCase", 25 - FINDINGS_LISTED_PER_KIND],
    ]);
    // Every finding gets a row for the findings list, which caps each kind
    // much higher than a route does.
    expect(findings).toHaveLength(26);
  });

  it("caps each kind in the findings list and keeps the rows a route lists", () => {
    const { data, findings } = pageParts(
      render(manyFindings(FINDINGS_LISTED_IN_ALL + 5), []),
    );

    expect(findings).toHaveLength(FINDINGS_LISTED_IN_ALL + 1);
    expect(data.fi).toHaveLength(findings.length);
    for (const at of data.e[0]?.f ?? []) {
      expect(data.fi[at]?.[2]).toBe(0);
    }
  });

  it("keeps finding text out of the inline data, in a compressed block", () => {
    const { dataText, findings } = pageParts(render(manyFindings(3), []));

    expect(dataText).not.toContain("Provider produces status 401");
    expect(findings[1]).toEqual([
      "unhandledProviderCase",
      "warning",
      "Provider produces status 401 but no consumer branch handles it",
      0,
      12,
      1,
      null,
    ]);
  });

  it("lists a finding placed on no route in the findings list, with its kind and severity", () => {
    const { data, findings } = pageParts(render(manyFindings(1), []));

    const at = findings.findIndex((row) => row[2] === "placed on no route");
    expect(at).toBeGreaterThanOrEqual(0);
    const [kind, severity, entry] = data.fi[at] ?? [];
    expect([data.s[kind as number], data.s[severity as number], entry]).toEqual(
      ["providerContractViolation", "error", null],
    );
  });

  it("puts a Findings tab in Browse and links the tile to it", () => {
    const html = render(manyFindings(2), []);

    expect(html).toContain('data-tab="findings"');
    expect(html).toContain('data-facet="findings:"');
  });
});
