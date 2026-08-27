import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { createTestProject } from "@suss/test-project";

import { nestjsMicroservicesFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { NestjsMicroservicesPackOptions } from "./index.js";

const NEST_TYPES: Readonly<Record<string, string>> = {
  "/node_modules/@nestjs/common/package.json": JSON.stringify({
    name: "@nestjs/common",
    types: "index.d.ts",
  }),
  "/node_modules/@nestjs/common/index.d.ts": `
    export declare function Controller(prefix?: string): ClassDecorator;
  `,
  "/node_modules/@nestjs/microservices/package.json": JSON.stringify({
    name: "@nestjs/microservices",
    types: "index.d.ts",
  }),
  "/node_modules/@nestjs/microservices/index.d.ts": `
    export declare function EventPattern(pattern?: string): MethodDecorator;
    export declare function MessagePattern(pattern?: string): MethodDecorator;
    export declare function Payload(field?: string): ParameterDecorator;
    export declare function Ctx(): ParameterDecorator;
  `,
};

async function extract(
  source: string,
  options?: NestjsMicroservicesPackOptions,
): Promise<BehavioralSummary[]> {
  const project = createTestProject();
  for (const [file, text] of Object.entries(NEST_TYPES)) {
    project.createSourceFile(file, text);
  }
  project.createSourceFile("/app/orders.controller.ts", source);
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [nestjsMicroservicesFramework(options)],
  });
  return await adapter.extractAll();
}

function channelsOf(summaries: BehavioralSummary[]): (string | null)[] {
  return summaries.map((one) => {
    const semantics = one.identity.boundaryBinding?.semantics;
    return semantics?.name === "message-bus" ? semantics.channel : null;
  });
}

const HANDLER = `
  import { Controller } from "@nestjs/common";
  import { EventPattern, Payload } from "@nestjs/microservices";

  @Controller()
  export class OrdersController {
    @EventPattern("order.placed")
    async handleOrderPlaced(@Payload() data: { id: string }) {
      return data.id;
    }
  }
`;

describe("nestjsMicroservicesFramework", () => {
  it("binds a handler to the channel its decorator states", async () => {
    const summaries = await extract(HANDLER);

    expect(summaries).toHaveLength(1);
    const semantics = summaries[0]?.identity.boundaryBinding?.semantics;
    expect(semantics).toMatchObject({
      name: "message-bus",
      messageBus: "nats",
      channel: "order.placed",
    });
    expect(summaries[0]?.kind).toBe("consumer");
  });

  it("says which broker through pack config, since the file never does", async () => {
    const summaries = await extract(HANDLER, { transport: "kafka" });

    const semantics = summaries[0]?.identity.boundaryBinding?.semantics;
    expect(semantics).toMatchObject({
      messageBus: "kafka",
      channel: "order.placed",
    });
  });

  it("follows a channel passed as a constant", async () => {
    const summaries = await extract(`
      import { Controller } from "@nestjs/common";
      import { MessagePattern } from "@nestjs/microservices";

      const GET_ORDER = "get.order";

      @Controller()
      export class OrdersController {
        @MessagePattern(GET_ORDER)
        async getOrder() {
          return {};
        }
      }
    `);

    expect(channelsOf(summaries)).toEqual(["get.order"]);
  });

  it("leaves the channel unnamed when the pattern is not a string", async () => {
    // An object-form pattern is a structured key v0 does not read. The
    // handler is still a consumer on the wire; it pairs the way a null
    // channel always has, rather than as a channel spelled wrong.
    const summaries = await extract(`
      import { Controller } from "@nestjs/common";
      import { MessagePattern } from "@nestjs/microservices";

      @Controller()
      export class OrdersController {
        @MessagePattern({ cmd: "sum" })
        async sum() {
          return 0;
        }
      }
    `);

    expect(channelsOf(summaries)).toEqual([null]);
  });

  it("finds nothing in a file without the microservice decorators", async () => {
    const summaries = await extract(`
      import { Controller } from "@nestjs/common";

      @Controller("orders")
      export class OrdersController {
        async list() {
          return [];
        }
      }
    `);

    expect(summaries).toEqual([]);
  });

  it("records one consumer per decorated method", async () => {
    const summaries = await extract(`
      import { Controller } from "@nestjs/common";
      import { EventPattern, MessagePattern } from "@nestjs/microservices";

      @Controller()
      export class OrdersController {
        @EventPattern("order.placed")
        async placed() {}

        @MessagePattern("get.order")
        async get() { return {}; }
      }
    `);

    expect(channelsOf(summaries).sort()).toEqual(["get.order", "order.placed"]);
  });
});
