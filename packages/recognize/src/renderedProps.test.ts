import { describe, expect, it } from "vitest";

import { callbacks } from "./callbacks.js";
import { constructedFrom } from "./ops.js";
import { declarationsIn, subUnitsOf } from "./pack.js";
import { renderedProps } from "./renderedProps.js";

import type {
  CallOps,
  ElementOps,
  SubUnitOpsCarrier,
  ValueForm,
  ValueOps,
} from "@suss/extractor";

/** A value written at an attribute: how the source wrote it, its text, and the function it settles to. */
function value(form: ValueForm, source: string, settles?: string): ValueOps {
  return {
    form: () => form,
    source: () => source,
    ast: () => source,
    function: () =>
      settles === undefined
        ? null
        : ({ ast: () => settles } as unknown as ValueOps),
  } as unknown as ValueOps;
}

function element(
  tag: string,
  attributes: Record<string, ValueOps>,
): ElementOps {
  return {
    tag: () => tag,
    attributes: () =>
      Object.entries(attributes).map(([name, held]) => ({
        name,
        value: held,
      })),
    props: () => Object.keys(attributes),
    spreads: () => [],
    hasChildren: () => false,
  };
}

const METADATA = {
  react: {
    kind: { reads: "text", text: "handler" },
    component: { reads: "parent" },
  },
} as const;

const EVENT = [{ position: 0, role: "event" }];

const HANDLERS = renderedProps({ matching: "^on[A-Z]" })
  .unitWhenInPlace({
    kind: "handler",
    name: ["parent", "callee", "prop", "countOnCollision"],
    inputs: EVENT,
    metadata: METADATA,
  })
  .unitWhenNamedInParent({
    kind: "handler",
    name: ["parent", "written"],
    inputs: EVENT,
    metadata: METADATA,
  })
  .example("<button onClick={() => save(order)}>Save</button>");

const parent = { func: "Panel's function", name: "Panel", kind: "component" };

/** A context whose parent renders these elements and writes the functions listed. */
function rendering(
  elements: readonly ElementOps[],
  written: readonly string[] = [],
  calls: readonly CallOps[] = [],
): SubUnitOpsCarrier {
  return {
    elements: () => elements,
    writes: (_parent, fn) =>
      written.includes(String((fn as unknown as { ast(): string }).ast())),
    calls: () => calls,
  };
}

describe("a chain over the elements a parent renders", () => {
  it("claims a function written in place under a matching attribute, numbering two with the same name in source order", () => {
    const claimed = subUnitsOf([HANDLERS])(
      parent,
      rendering([
        element("button", {
          type: value("other", '"button"'),
          onClick: value("function", "first"),
        }),
        element("a", { onClick: value("function", "link") }),
        element("button", { onClick: value("function", "second") }),
      ]),
    );

    expect(claimed.map((one) => [one.func, one.name])).toEqual([
      ["first", "Panel.button.onClick#0"],
      ["link", "Panel.a.onClick"],
      ["second", "Panel.button.onClick#1"],
    ]);
    expect(claimed[0]?.inputMapping).toEqual({
      type: "positionalParams",
      params: [{ position: 0, role: "event" }],
    });
    expect(claimed[0]?.metadata).toEqual({
      react: { kind: "handler", component: "Panel" },
    });
  });

  it("claims a function handed over by name only when the parent writes it", () => {
    const claimed = subUnitsOf([HANDLERS])(
      parent,
      rendering(
        [
          element("form", {
            onSubmit: value("name", "save", "the save arrow"),
            onReset: value("name", "outside", "a function elsewhere"),
            onBlur: value("name", "onBlur"),
            onFocus: value("other", "props.onFocus"),
            title: value("function", "not a handler"),
          }),
        ],
        ["the save arrow"],
      ),
    );

    expect(claimed.map((one) => [one.func, one.name])).toEqual([
      ["the save arrow", "Panel.save"],
    ]);
  });

  it("claims nothing where the adapter lists no elements, as Python and Ruby leave it", () => {
    expect(subUnitsOf([HANDLERS])(parent, {})).toEqual([]);
  });

  it("comes before a call chain's claims, and goes by its claims in the pack health report", () => {
    const watched = callbacks({ client: constructedFrom("@acme/jobs") })
      .methods({ watch: { callback: { written: "callback", at: 0 } } })
      .unitWhenInPlace({ kind: "handler", name: ["parent", "callee"] });
    const call = {
      method: () => null,
      calleeText: () => "watch",
      isFrom: () => true,
      receiverIsFrom: () => true,
      valueAt: (at: number) => (at === 0 ? value("function", "watcher") : null),
    } as unknown as CallOps;
    const claimed = subUnitsOf([watched, HANDLERS])(
      parent,
      rendering(
        [element("button", { onClick: value("function", "clicked") })],
        [],
        [call],
      ),
    );

    expect(claimed.map((one) => one.name)).toEqual([
      "Panel.button.onClick",
      "Panel.watch",
    ]);
    expect(declarationsIn([HANDLERS]).declarations).toEqual([
      expect.objectContaining({
        name: "claims",
        example: "<button onClick={() => save(order)}>Save</button>",
      }),
    ]);
  });
});
