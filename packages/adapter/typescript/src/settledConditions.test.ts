// Each test writes the condition of an `if` inside `check` one way
// production code writes it, and asks whether the condition comes out
// the same on every run.
import { Node } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "./facts/store.js";
import { settledConditionOf } from "./settledConditions.js";

function settled(source: string) {
  const project = createTestProject();
  const file = project.createSourceFile("/repo.ts", source);
  const check = file.getFunctionOrThrow("check");
  const test = check.getDescendants().find((node) => Node.isIfStatement(node));
  if (!Node.isIfStatement(test)) {
    throw new Error("check has no if");
  }
  return settledConditionOf(test.getExpression(), new ResolutionStore());
}

const HELPERS = `
interface Order { id: string }
declare const db: { find(id: string): Promise<Order | null> };
function toOrder(row: Order): Order {
  return { id: row.id };
}
`;

describe("a condition that always comes out the same way", () => {
  it("reads every value an awaited helper returns as an object", () => {
    expect(
      settled(`${HELPERS}
async function loadOrder(id: string): Promise<Order> {
  const row = await db.find(id);
  return row ? toOrder(row) : ({} as Order);
}
async function check(id: string) {
  const order = await loadOrder(id);
  if (!order) {}
}`),
    ).toMatchObject({ truth: false, every: "truthy" });
  });

  it("reads a const bound to an arrow function", () => {
    expect(
      settled(`
const empty = () => [];
function check() {
  const items = empty();
  if (items) {}
}`),
    ).toMatchObject({ truth: true, every: "truthy" });
  });

  it("reads a literal false", () => {
    expect(
      settled(`
function check() {
  const enabled = false;
  if (enabled) {}
}`),
    ).toMatchObject({ truth: false, every: "falsy" });
  });

  it("reads both arms of a try whose catch also returns an object", () => {
    expect(
      settled(`
function load(): object {
  try {
    return { found: true };
  } catch {
    return {};
  }
}
function check() {
  const found = load();
  if (!found) {}
}`),
    ).toMatchObject({ truth: false, every: "truthy" });
  });
});

describe("a condition some run could answer the other way", () => {
  const unsettled = (source: string) => expect(settled(source)).toBeNull();

  it("leaves a helper alone when one of its values is unread", () => {
    unsettled(`${HELPERS}
declare function lookup(id: string): Order | null;
async function loadOrder(id: string) {
  const row = await db.find(id);
  return row ? toOrder(row) : lookup(id);
}
async function check(id: string) {
  const order = await loadOrder(id);
  if (!order) {}
}`);
  });

  it("leaves an async helper alone when the call is not awaited", () => {
    unsettled(`
async function loadOrder() {
  return null;
}
function check() {
  const order = loadOrder();
  if (order) {}
}`);
  });

  it("leaves a generator alone", () => {
    unsettled(`
function* orders() {
  return null;
}
function check() {
  const order = orders();
  if (order) {}
}`);
  });

  it("leaves a name written twice alone", () => {
    unsettled(`
function check(flag: boolean) {
  let order: object | null = {};
  if (flag) {
    order = null;
  }
  if (!order) {}
}`);
  });

  it("leaves a name an increment writes alone", () => {
    unsettled(`
function check() {
  let count = 0;
  count++;
  if (count) {}
}`);
  });

  it("leaves a shadowed name alone", () => {
    unsettled(`
function check() {
  const order = {};
  {
    const order = null;
  }
  if (!order) {}
}`);
  });

  it("leaves a destructured name alone", () => {
    unsettled(`
function load() {
  return { order: {} };
}
function check() {
  const { order } = load();
  if (!order) {}
}`);
  });

  it("leaves a method call alone", () => {
    unsettled(`
class Orders {
  load() {
    return {};
  }
  check() {}
}
function check(orders: Orders) {
  const order = orders.load();
  if (!order) {}
}`);
  });

  it("leaves a function reached through a wrapper alone", () => {
    unsettled(`
declare function wrap<T>(fn: T): T;
const load = wrap(() => ({}));
function check() {
  const order = load();
  if (!order) {}
}`);
  });

  it("leaves a try alone when its catch can return null", () => {
    unsettled(`
function load(): object | null {
  try {
    return {};
  } catch {
    return null;
  }
}
function check() {
  const found = load();
  if (!found) {}
}`);
  });

  it("leaves a function with a this parameter alone", () => {
    unsettled(`
function load(this: unknown, found: object | null) {
  return found;
}
function check() {
  const order = load(null);
  if (order) {}
}`);
  });

  it("leaves a try alone when its finally returns", () => {
    unsettled(`
function load(): object | null {
  try {
    return {};
  } finally {
    return null;
  }
}
function check() {
  const found = load();
  if (!found) {}
}`);
  });

  it("leaves a parameter with a default alone, since passing undefined gets the default", () => {
    unsettled(`
function load(found: object | undefined = {}) {
  return found;
}
function check() {
  const order = load(undefined);
  if (order) {}
}`);
  });

  it("leaves a parameter alone", () => {
    unsettled(`
function check(order: object) {
  if (!order) {}
}`);
  });

  it("leaves a name from outside the function alone", () => {
    unsettled(`
const EMPTY = {};
function check() {
  if (!EMPTY) {}
}`);
  });
});
