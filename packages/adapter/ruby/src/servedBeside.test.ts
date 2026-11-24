import { describe, expect, it } from "vitest";

import { readServedBesideMetadata, restBinding } from "@suss/behavioral-ir";

import { stampRubyServedBeside } from "./servedBeside.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { ControllerActions, RubyPack } from "./pack.js";

function action(recognition: string): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: "app/controllers/orders_controller.rb",
      range: { start: 2, end: 4 },
      exportName: null,
    },
    identity: {
      name: "OrdersController.totals",
      exportPath: null,
      boundaryBinding: restBinding({
        transport: "http",
        recognition,
        method: "GET",
        path: "/orders/:id/totals",
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

function packWith(
  routedElsewhere: ControllerActions["routedElsewhere"],
): RubyPack {
  return {
    name: "shop-rails",
    discovery: [
      {
        type: "controllerActions",
        routesFile: "/shop/config/routes.rb",
        routedElsewhere,
      } as unknown as ControllerActions,
    ],
    servedBeside: { staticDirectories: ["/shop/no-such-directory"] },
  } as unknown as RubyPack;
}

describe("what a Ruby framework pack states beside its routes", () => {
  it("goes on each route the pack recognized, with what its routing sends elsewhere", () => {
    const own = action("shop-rails");
    const other = action("other-framework");
    const mount = {
      by: "mount" as const,
      path: "/jobs/{path*}",
      file: "/shop/config/routes.rb",
      line: 1,
    };

    stampRubyServedBeside(
      [own, other],
      [packWith(() => [mount])],
      () => undefined,
    );

    expect(readServedBesideMetadata(own)).toEqual({
      pack: "shop-rails",
      entries: [mount],
    });
    expect(readServedBesideMetadata(other)).toBeUndefined();
  });

  it("covers every path when the routing could not be read", () => {
    const own = action("shop-rails");

    stampRubyServedBeside(
      [own],
      [
        packWith(() => {
          throw new Error("unreadable routes file");
        }),
      ],
      () => undefined,
    );

    expect(readServedBesideMetadata(own)?.entries).toEqual([
      {
        by: "unread",
        file: "/shop/config/routes.rb",
        line: 1,
        written: "the routing",
      },
    ]);
  });

  it("says nothing for a pack that states nothing", () => {
    const own = action("shop-rails");
    const { servedBeside: _stated, ...silent } = packWith(() => []);

    stampRubyServedBeside([own], [silent], () => undefined);

    expect(readServedBesideMetadata(own)).toBeUndefined();
  });
});
