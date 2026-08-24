import { describe, expect, it } from "vitest";

import {
  packUnderTest,
  storageByOperation,
  storageOf,
} from "@suss/pack-harness";
import { runExamples } from "@suss/recognize";

import { mongooseFramework } from "./index.js";

import type { Effect } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

/**
 * The recognizer settles a call by where its method is declared, so a
 * fixture needs a client library on disk to resolve against. This
 * stub covers the shapes the tests below exercise: a hybrid
 * constructable/interface Model, a Document with save(), the model()
 * factory, and the Schema constructor. Not generic over the document
 * shape: the recognizer works off the AST arguments a call is written
 * with, never off TypeScript's own inferred field types, so a type
 * parameter here would test nothing extra and risks collapsing to
 * `any` (losing every member) at one of the shapes exercised below.
 */
const MONGOOSE_TYPES = `
  export interface Document {
    save(options?: unknown): Promise<this>;
  }
  export interface Model {
    new (doc?: Record<string, unknown>): Document;
    find(filter?: object, projection?: unknown, options?: unknown): Promise<Document[]>;
    findOne(filter?: object, projection?: unknown, options?: unknown): Promise<Document | null>;
    findById(id: unknown, projection?: unknown, options?: unknown): Promise<Document | null>;
    countDocuments(filter?: object): Promise<number>;
    exists(filter?: object): Promise<{ _id: unknown } | null>;
    distinct(field: string, filter?: object): Promise<unknown[]>;
    create(doc: unknown): Promise<Document>;
    insertMany(docs: unknown): Promise<Document[]>;
    updateOne(filter: object, update: object): Promise<unknown>;
    updateMany(filter: object, update: object): Promise<unknown>;
    replaceOne(filter: object, replacement: object): Promise<unknown>;
    deleteOne(filter?: object): Promise<unknown>;
    deleteMany(filter?: object): Promise<unknown>;
    findOneAndUpdate(filter: object, update: object): Promise<Document | null>;
    findByIdAndUpdate(id: unknown, update: object): Promise<Document | null>;
    findOneAndDelete(filter?: object): Promise<Document | null>;
    findByIdAndDelete(id: unknown): Promise<Document | null>;
    findOneAndReplace(filter: object, replacement: object): Promise<Document | null>;
  }
  export declare class Schema {
    constructor(fields?: object, options?: object);
  }
  export declare function model(name: string, schema?: Schema, collection?: string): Model;
  declare class Mongoose {
    model: typeof model;
    Schema: typeof Schema;
  }
  declare const mongoose: Mongoose;
  export default mongoose;
`;

const mongoose = packUnderTest(mongooseFramework(), {
  library: { mongoose: MONGOOSE_TYPES },
});

const effectsIn = (
  source: string,
  pack: PatternPack = mongooseFramework(),
): Effect[] =>
  packUnderTest(pack, { library: { mongoose: MONGOOSE_TYPES } }).effectsIn(
    source,
  );

const CLIENT = `
  import mongoose from "mongoose";
  const userSchema = new mongoose.Schema({ name: String, email: String });
  const User = mongoose.model("User", userSchema);
`;

describe("a static Model call", () => {
  it("reads the projection's fields and the filter's selector", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function getUser(email: string) {
        return User.find({ email }, { name: 1, email: 1 });
      }
    `);

    expect(effects).toHaveLength(1);
    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics).toMatchObject({
      storageSystem: "mongodb",
      scope: "default",
      container: "users",
    });
    expect(interaction).toMatchObject({
      class: "storage-access",
      kind: "read",
      operation: "find",
      fields: ["name", "email"],
      selector: ["email"],
    });
  });

  it("reads a space-delimited string projection", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function getUser(email: string) {
        return User.findOne({ email }, "name email -_id");
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      fields: ["name", "email"],
    });
  });

  it("reads a pure-exclusion projection as the whole document", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function getUser(email: string) {
        return User.findOne({ email }, { password: 0 });
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({ fields: ["*"] });
  });

  it("reads the whole document when there is no projection at all", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function getUser(email: string) {
        return User.findOne({ email });
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({ fields: ["*"] });
  });

  it("selects by _id for findById", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function getUser(id: string) {
        return User.findById(id, { name: 1 });
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      operation: "findById",
      selector: ["_id"],
      fields: ["name"],
    });
  });

  it("reads no fields for countDocuments and exists", () => {
    const counts = effectsIn(`
      ${CLIENT}
      export async function countActive() {
        return User.countDocuments({ active: true });
      }
    `);
    expect(storageOf(counts[0]).interaction).toMatchObject({
      kind: "read",
      fields: [],
      selector: ["active"],
    });

    const exists = effectsIn(`
      ${CLIENT}
      export async function hasUser(email: string) {
        return User.exists({ email });
      }
    `);
    expect(storageOf(exists[0]).interaction).toMatchObject({
      kind: "read",
      fields: [],
    });
  });

  it("reads the field distinct names, and the filter beside it", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function emails() {
        return User.distinct("email", { active: true });
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      fields: ["email"],
      selector: ["active"],
    });
  });

  it("reads a create payload's fields", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function addUser(name: string, email: string) {
        return User.create({ name, email });
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "write",
      operation: "create",
      fields: ["name", "email"],
    });
  });

  it("unions the fields across an array of created documents", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function seed() {
        return User.insertMany([{ name: "a" }, { email: "b" }]);
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      fields: ["name", "email"],
    });
  });

  it("falls back to the whole row when a created document isn't a plain object", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function seed(extra: unknown) {
        return User.insertMany([{ name: "a" }, extra]);
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({ fields: ["*"] });
  });

  it("reads fields under an update operator, and a plain assignment beside it", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function rename(id: string, name: string) {
        return User.updateOne({ _id: id }, { $set: { name }, active: true });
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      fields: ["name", "active"],
    });
  });

  it("reads no fields for an update operator with no object operand", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function touch(id: string) {
        return User.updateOne({ _id: id }, { $currentDate: true });
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({ fields: ["*"] });
  });

  it("falls back to the whole document when a key is built at run time", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function touch(id: string, field: string) {
        return User.updateOne({ _id: id }, { [field]: true });
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({ fields: ["*"] });
  });

  it("falls back to the whole document when the update isn't a readable object", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function apply(id: string, update: object) {
        return User.updateOne({ _id: id }, update);
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({ fields: ["*"] });
  });

  it("reads a replacement's fields, alongside the filter", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function replace(id: string, name: string) {
        return User.replaceOne({ _id: id }, { name });
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      fields: ["name"],
      selector: ["_id"],
    });
  });

  it("marks a delete as touching the whole document", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function remove(email: string) {
        return User.deleteOne({ email });
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "write",
      fields: ["*"],
      selector: ["email"],
    });
  });

  it("selects by _id for findByIdAndDelete", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function remove(id: string) {
        return User.findByIdAndDelete(id);
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      selector: ["_id"],
      fields: ["*"],
    });
  });

  it("reads the update fields of findOneAndUpdate and findByIdAndUpdate", () => {
    const byFilter = effectsIn(`
      ${CLIENT}
      export async function bump(email: string) {
        return User.findOneAndUpdate({ email }, { $set: { active: true } });
      }
    `);
    expect(storageOf(byFilter[0]).interaction).toMatchObject({
      fields: ["active"],
      selector: ["email"],
    });

    const byId = effectsIn(`
      ${CLIENT}
      export async function bump(id: string) {
        return User.findByIdAndUpdate(id, { $set: { active: true } });
      }
    `);
    expect(storageOf(byId[0]).interaction).toMatchObject({
      fields: ["active"],
      selector: ["_id"],
    });
  });

  it("reads findOneAndReplace like a replacement, and findOneAndDelete like a delete", () => {
    const replaced = effectsIn(`
      ${CLIENT}
      export async function replace(email: string, name: string) {
        return User.findOneAndReplace({ email }, { name });
      }
    `);
    expect(storageOf(replaced[0]).interaction).toMatchObject({
      fields: ["name"],
      selector: ["email"],
    });

    const deleted = effectsIn(`
      ${CLIENT}
      export async function remove(email: string) {
        return User.findOneAndDelete({ email });
      }
    `);
    expect(storageOf(deleted[0]).interaction).toMatchObject({
      fields: ["*"],
      selector: ["email"],
    });
  });

  it("leaves a same-named method on something else alone", () => {
    expect(
      effectsIn(`
        declare const cache: { find(filter: unknown): Promise<unknown> };
        export async function read() {
          return cache.find({ id: 1 });
        }
      `),
    ).toEqual([]);
  });
});

describe("collection naming", () => {
  it("pluralizes the model name by default", () => {
    const effects = effectsIn(`
      import mongoose from "mongoose";
      const Category = mongoose.model("Category", new mongoose.Schema({}));
      export async function all() {
        return Category.find({});
      }
    `);

    expect(storageOf(effects[0]).semantics.container).toBe("categories");
  });

  it("adds es after a sibilant", () => {
    const effects = effectsIn(`
      import mongoose from "mongoose";
      const Box = mongoose.model("Box", new mongoose.Schema({}));
      export async function all() {
        return Box.find({});
      }
    `);

    expect(storageOf(effects[0]).semantics.container).toBe("boxes");
  });

  it("takes an explicit third argument over the default", () => {
    const effects = effectsIn(`
      import mongoose from "mongoose";
      const User = mongoose.model("User", new mongoose.Schema({}), "accounts");
      export async function all() {
        return User.find({});
      }
    `);

    expect(storageOf(effects[0]).semantics.container).toBe("accounts");
  });

  it("takes the schema's own collection option over the default", () => {
    const effects = effectsIn(`
      import mongoose from "mongoose";
      const schema = new mongoose.Schema({}, { collection: "people" });
      const User = mongoose.model("User", schema);
      export async function all() {
        return User.find({});
      }
    `);

    expect(storageOf(effects[0]).semantics.container).toBe("people");
  });

  it("resolves the bare model() import the same way", () => {
    const effects = effectsIn(`
      import { model, Schema } from "mongoose";
      const Post = model("Post", new Schema({}));
      export async function all() {
        return Post.find({});
      }
    `);

    expect(storageOf(effects[0]).semantics.container).toBe("posts");
  });

  it("follows a model imported from another file", () => {
    const effects = mongoose.effectsAcross(
      {
        "/models.ts": `
      import mongoose from "mongoose";
      export const User = mongoose.model("User", new mongoose.Schema({}));
    `,
        "/repo.ts": `
      import { User } from "./models.js";
      export async function all() {
        return User.find({});
      }
    `,
      },
      "/repo.ts",
    );

    expect(storageOf(effects[0]).semantics.container).toBe("users");
  });

  it("records the crossing with a null container when the receiver can't be traced", () => {
    const effects = effectsIn(`
      import type { Model } from "mongoose";
      export async function all(SomeModel: Model) {
        return SomeModel.find({ name: "x" });
      }
    `);

    expect(effects).toHaveLength(1);
    expect(storageOf(effects[0]).semantics.container).toBeNull();
  });
});

describe("save()", () => {
  it("resolves the model of a document constructed directly", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function addUser(name: string) {
        const u = new User({ name });
        await u.save();
      }
    `);

    expect(effects).toHaveLength(1);
    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics.container).toBe("users");
    expect(interaction).toMatchObject({
      operation: "save",
      kind: "write",
      fields: ["*"],
    });
  });

  it("resolves the model of a document read off a query", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function rename(id: string, name: string) {
        const doc = await User.findById(id);
        doc.name = name;
        await doc.save();
      }
    `);

    expect(storageByOperation(effects, "save").semantics.container).toBe(
      "users",
    );
  });

  it("records save() with a null container when the document can't be traced", () => {
    const effects = effectsIn(`
      import type { Document } from "mongoose";
      export async function persist(doc: Document) {
        await doc.save();
      }
    `);

    expect(effects).toHaveLength(1);
    expect(storageOf(effects[0]).semantics.container).toBeNull();
  });

  it("leaves a same-named method on something else alone", () => {
    expect(
      effectsIn(`
        declare const form: { save(): Promise<void> };
        export async function submit() {
          await form.save();
        }
      `),
    ).toEqual([]);
  });
});

describe("the pack itself", () => {
  it("is a recognizer-only pack scoped to mongoose", () => {
    expect(mongooseFramework()).toMatchObject({
      name: "mongoose",
      protocol: "in-process",
      discovery: [],
      terminals: [],
      requiresImport: ["mongoose"],
    });
    expect(mongooseFramework().invocationRecognizers).toHaveLength(1);
  });

  it("prices what it declared: the collection and two rules are code", () => {
    expect(mongooseFramework().declarations?.declarations).toEqual([
      {
        name: "mongodb",
        dataLinks: 2,
        functionLinks: ["container", "selector", "fields"],
        astLinks: [],
        example: 'User.find({ email: "a@b.c" }, { name: 1 })',
      },
    ]);
  });

  it("emits the effect its example says it does", () => {
    const ran = runExamples(mongooseFramework(), (code) =>
      effectsIn(`
        ${CLIENT}
        export async function example() {
          return ${code};
        }
      `),
    );

    expect(ran).toHaveLength(1);
    const { semantics, interaction } = storageOf(ran[0].effects[0]);
    expect(semantics.container).toBe("users");
    expect(interaction).toMatchObject({
      class: "storage-access",
      kind: "read",
      operation: "find",
      fields: ["name"],
      selector: ["email"],
    });
  });

  it("takes a scope option for a project with more than one connection", () => {
    const effects = effectsIn(
      `${CLIENT}\nexport async function all() { return User.find({}); }`,
      mongooseFramework({ scope: "reporting" }),
    );

    expect(storageOf(effects[0]).semantics.scope).toBe("reporting");
  });
});
