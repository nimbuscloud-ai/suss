import { describe, expect, it } from "vitest";

import { packUnderTest, storageOf } from "@suss/pack-harness";
import { runExamples } from "@suss/recognize";

import { typeormFramework } from "./index.js";

import type { Effect } from "@suss/behavioral-ir";

// Neither library is installed, as in a project extracted without its
// node_modules: the pack has to match on the imports the source writes.
const typeorm = packUnderTest(typeormFramework());

const ORDER = `
  import { Entity } from "typeorm";
  @Entity("orders")
  export class Order {}
`;

/** A service with `orders` injected, and `body` as the rest of the class. */
function serviceWith(body: string): string {
  return `
    import { InjectRepository } from "@nestjs/typeorm";
    import { Repository } from "typeorm";
    import { Order } from "./order";
    export class OrdersService {
      constructor(
        @InjectRepository(Order) private readonly orders: Repository<Order>,
      ) {}
      ${body}
    }
  `;
}

function effectsIn(service: string, order: string = ORDER): Effect[] {
  return typeorm.effectsAcross(
    { "/order.ts": order, "/service.ts": service },
    "/service.ts",
  );
}

/** The one storage access a method body records. */
function accessIn(body: string, order?: string) {
  const effects = effectsIn(serviceWith(body), order);
  expect(effects).toHaveLength(1);
  return storageOf(effects[0] as Effect);
}

describe("a call on an injected repository", () => {
  it("reads the columns a find selects, by the columns its condition names", () => {
    const { semantics, interaction } = accessIn(`
      list() {
        return this.orders.find({ where: { status: "open" }, select: { id: true, total: true } });
      }
    `);

    expect(semantics).toMatchObject({
      storageSystem: "postgresql",
      scope: "default",
      container: "orders",
    });
    expect(interaction).toMatchObject({
      class: "storage-access",
      kind: "read",
      operation: "find",
      fields: ["id", "total"],
      selector: ["status"],
    });
  });

  it("reads every column when a find selects none", () => {
    const { interaction } = accessIn(`
      one(id: string) { return this.orders.findOne({ where: { id } }); }
    `);

    expect(interaction).toMatchObject({ fields: ["*"], selector: ["id"] });
  });

  it("reads a select written as a list of column names", () => {
    const { interaction } = accessIn(`
      list() { return this.orders.find({ select: ["id", "status"] }); }
    `);

    expect(interaction.fields).toEqual(["id", "status"]);
  });

  it("takes the columns of every condition in a list of them", () => {
    const { interaction } = accessIn(`
      list() { return this.orders.find({ where: [{ status: "open" }, { owner: "a" }] }); }
    `);

    expect(interaction.selector).toEqual(["status", "owner"]);
  });

  it("reads the condition a findOneBy is handed as its argument", () => {
    const { interaction } = accessIn(`
      one(id: string) { return this.orders.findOneBy({ id }); }
    `);

    expect(interaction).toMatchObject({
      kind: "read",
      fields: ["*"],
      selector: ["id"],
    });
  });

  it("records a count with no columns read", () => {
    const { interaction } = accessIn(`
      open() { return this.orders.countBy({ status: "open" }); }
    `);

    expect(interaction).toMatchObject({
      kind: "read",
      fields: [],
      selector: ["status"],
    });
  });

  it("writes the columns an update sets, on the rows its condition picks", () => {
    const { interaction } = accessIn(`
      close(id: string) { return this.orders.update({ id }, { status: "closed" }); }
    `);

    expect(interaction).toMatchObject({
      kind: "write",
      operation: "update",
      fields: ["status"],
      selector: ["id"],
    });
  });

  it("writes the columns of every entity a save is handed", () => {
    const { interaction } = accessIn(`
      add() { return this.orders.save([{ status: "open" }, { total: 3 }]); }
    `);

    expect(interaction).toMatchObject({
      kind: "write",
      fields: ["status", "total"],
    });
  });

  it("writes every column when a saved entity cannot be read", () => {
    const { interaction } = accessIn(`
      add(order: Order) { return this.orders.save(order); }
    `);

    expect(interaction.fields).toEqual(["*"]);
  });

  it("writes the whole row a delete removes", () => {
    const { interaction } = accessIn(`
      drop(id: string) { return this.orders.delete({ id }); }
    `);

    expect(interaction).toMatchObject({
      kind: "write",
      fields: ["*"],
      selector: ["id"],
    });
  });

  it("follows a field the constructor assigns from the parameter", () => {
    const effects = effectsIn(`
      import { InjectRepository } from "@nestjs/typeorm";
      import { Order } from "./order";
      export class OrdersService {
        private readonly orders: any;
        constructor(@InjectRepository(Order) orders: any) { this.orders = orders; }
        list() { return this.orders.find(); }
      }
    `);

    expect(effects).toHaveLength(1);
    expect(storageOf(effects[0] as Effect).semantics.container).toBe("orders");
  });

  it("leaves out a call that makes an entity without touching the table", () => {
    expect(
      effectsIn(serviceWith("make() { return this.orders.create({}); }")),
    ).toEqual([]);
  });
});

describe("the table an entity is stored in", () => {
  it("reads the name from the options @Entity is handed", () => {
    const { semantics } = accessIn(
      "list() { return this.orders.find(); }",
      `
        import { Entity } from "typeorm";
        @Entity({ name: "order_rows", schema: "sales" })
        export class Order {}
      `,
    );

    expect(semantics.container).toBe("order_rows");
  });

  it("takes TypeORM's default name when @Entity states none", () => {
    const effects = effectsIn(
      `
        import { InjectRepository } from "@nestjs/typeorm";
        import { OrderLine } from "./order";
        export class LinesService {
          constructor(@InjectRepository(OrderLine) private readonly lines: any) {}
          list() { return this.lines.find(); }
        }
      `,
      `
        import { Entity } from "typeorm";
        @Entity()
        export class OrderLine {}
      `,
    );

    expect(storageOf(effects[0] as Effect).semantics.container).toBe(
      "order_line",
    );
  });

  it("records the call with no table when the entity cannot be found", () => {
    const effects = typeorm.effectsIn(`
      import { InjectRepository } from "@nestjs/typeorm";
      import { Order } from "./missing";
      export class OrdersService {
        constructor(@InjectRepository(Order) private readonly orders: any) {}
        list() { return this.orders.find(); }
      }
    `);

    expect(effects).toHaveLength(1);
    expect(storageOf(effects[0] as Effect).semantics.container).toBeNull();
  });
});

describe("a receiver the pack leaves alone", () => {
  it("ignores a repository that no decorator injected", () => {
    expect(
      effectsIn(`
        import { Repository } from "typeorm";
        import { Order } from "./order";
        export class OrdersService {
          constructor(private readonly orders: Repository<Order>) {}
          list() { return this.orders.find(); }
        }
      `),
    ).toEqual([]);
  });

  it("ignores a decorator with the same name from another module", () => {
    expect(
      effectsIn(`
        import { InjectRepository } from "./decorators";
        import { Order } from "./order";
        export class OrdersService {
          constructor(@InjectRepository(Order) private readonly orders: any) {}
          list() { return this.orders.find(); }
        }
      `),
    ).toEqual([]);
  });
});

describe("a statement run through an injected data source", () => {
  it("reads the tables the statement names", () => {
    const effects = typeorm.effectsIn(`
      import { InjectDataSource } from "@nestjs/typeorm";
      import { DataSource } from "typeorm";
      export class Report {
        constructor(@InjectDataSource() private readonly source: DataSource) {}
        run() { return this.source.query("SELECT id FROM orders"); }
      }
    `);

    expect(effects).toHaveLength(1);
    const { semantics, interaction } = storageOf(effects[0] as Effect);
    expect(semantics.container).toBe("orders");
    expect(interaction).toMatchObject({ kind: "read", fields: ["id"] });
  });
});

describe("the pack's examples", () => {
  it("emits the effects its examples say it does", () => {
    const ran = runExamples(typeormFramework(), (code) =>
      effectsIn(`
        import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
        import { Order } from "./order";
        export class Example {
          constructor(
            @InjectRepository(Order) private readonly orders: any,
            @InjectDataSource() private readonly source: any,
          ) {}
          run() { return ${code}; }
        }
      `),
    );

    expect(ran).toHaveLength(2);
    for (const example of ran) {
      expect(storageOf(example.effects[0] as Effect).semantics.container).toBe(
        "orders",
      );
    }
  });
});
