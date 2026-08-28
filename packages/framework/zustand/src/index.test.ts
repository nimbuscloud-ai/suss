import { describe, expect, it } from "vitest";

import { packUnderTest, storageOf } from "@suss/pack-harness";

import { zustandFramework } from "./index.js";

import type { Effect } from "@suss/behavioral-ir";

const ZUSTAND_TYPES = `
  export interface StoreApi<T> {
    setState(partial: Partial<T> | ((s: T) => Partial<T>)): void;
    getState(): T;
    subscribe(listener: (s: T) => void): () => void;
  }
  export declare function create<T>(
    init: (set: StoreApi<T>["setState"]) => T,
  ): StoreApi<T>;
`;

const zustand = packUnderTest(zustandFramework(), {
  library: { zustand: ZUSTAND_TYPES },
});

const effectsIn = (source: string): Effect[] => zustand.effectsIn(source);

const STORE = `
  import { create } from "zustand";
  const useAppStore = create<{ bears: number; honey: number }>((set) => ({
    bears: 0,
    honey: 0,
  }));
`;

describe("a zustand store access", () => {
  it("reads setState as a write of the stated fields", () => {
    const effects = effectsIn(`
      ${STORE}
      export function reset() {
        useAppStore.setState({ bears: 0, honey: 0 });
      }
    `);

    expect(effects).toHaveLength(1);
    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics).toMatchObject({
      storageSystem: "client-store",
      container: "useAppStore",
    });
    expect(interaction).toMatchObject({
      class: "storage-access",
      kind: "write",
      operation: "setState",
      fields: ["bears", "honey"],
    });
  });

  it("reads getState as a read of the store", () => {
    const effects = effectsIn(`
      ${STORE}
      export function currentBears() {
        return useAppStore.getState().bears;
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "read",
      operation: "getState",
    });
  });

  it("gives a functional setState no fields rather than wrong ones", () => {
    const effects = effectsIn(`
      ${STORE}
      export function moreBears() {
        useAppStore.setState((s) => ({ bears: s.bears + 1 }));
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "write",
      fields: [],
    });
  });

  it("skips a spread entry and keeps the stated fields", () => {
    const effects = effectsIn(`
      ${STORE}
      const base = { honey: 1 };
      export function refill() {
        useAppStore.setState({ ...base, bears: 2 });
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "write",
      fields: ["bears"],
    });
  });

  it("settles a computed key it can, and skips one it cannot", () => {
    const effects = effectsIn(`
      ${STORE}
      const known = "bears";
      export function dynamicWrite(unknownKey: string) {
        useAppStore.setState({ [known]: 3, [unknownKey]: 4, honey: 5 });
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "write",
      fields: ["bears", "honey"],
    });
  });

  it("recognizes a destructured method without inventing a store name", () => {
    const effects = effectsIn(`
      ${STORE}
      const { setState } = useAppStore;
      export function resetAll() {
        setState({ bears: 0 });
      }
    `);

    if (effects.length > 0) {
      expect(storageOf(effects[0]).semantics).toMatchObject({
        container: null,
      });
    }
  });

  it("reads the hook's selector form as a read of the picked fields", () => {
    const effects = effectsIn(`
      ${STORE}
      export function BearCounter() {
        const bears = useAppStore((s) => s.bears);
        return bears;
      }
    `);

    expect(effects).toHaveLength(1);
    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics).toMatchObject({
      storageSystem: "client-store",
      container: "useAppStore",
    });
    expect(interaction).toMatchObject({
      class: "storage-access",
      kind: "read",
      fields: ["bears"],
    });
  });

  it("reads a whole-store call as a read of everything", () => {
    const effects = effectsIn(`
      ${STORE}
      export function everything() {
        const all = useAppStore((s) => s);
        return all;
      }
    `);

    expect(effects).toHaveLength(1);
    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "read",
      fields: ["*"],
    });
  });

  it("leaves the store definition itself alone", () => {
    const effects = effectsIn(`
      ${STORE}
      export function nothingHere() {
        return 1;
      }
    `);

    expect(effects).toHaveLength(0);
  });

  it("leaves a same-named method on an unrelated object alone", () => {
    const effects = effectsIn(`
      const notAStore = {
        setState(x: Record<string, number>) {
          return x;
        },
      };
      export function unrelated() {
        notAStore.setState({ bears: 1 });
      }
    `);

    expect(effects).toHaveLength(0);
  });
});
