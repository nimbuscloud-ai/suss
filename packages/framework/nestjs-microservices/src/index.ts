/**
 * Discovery works the way it does in the REST pack, by decorator, and
 * the boundary comes from a declared binding. The channel is the first
 * argument of `@EventPattern` or `@MessagePattern`. The broker comes from
 * pack options, because bootstrap wires the transport and the handler's
 * file never mentions it. The README lists what the pack does not read.
 */

import { z } from "zod";

import type { DeclaredBinding, PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";

/** The NestJS transports that suss has a message bus name for. */
export type NestjsTransport = Extract<
  DeclaredBinding["messageBus"],
  "nats" | "kafka" | "bullmq"
>;

const TRANSPORTS = [
  "nats",
  "kafka",
  "bullmq",
] as const satisfies readonly NestjsTransport[];

/**
 * The CLI checks a `-f nestjs-microservices=config.json` file against this
 * schema. A config file may not set a key that only a dependency stub
 * fills.
 */
export const optionsSchema = z
  .object({
    /**
     * The broker the project connects at bootstrap. The handler's file
     * never mentions it. Defaults to NATS.
     */
    transport: z.enum(TRANSPORTS).optional(),
    /**
     * Class decorators that wrap `@Controller()` in a package outside the
     * project, as in the REST pack. A dependency stub fills this.
     */
    classDecorators: z.array(z.string()).optional(),
  })
  .strict();

export type NestjsMicroservicesPackOptions = z.infer<typeof optionsSchema>;

export function nestjsMicroservicesFramework(
  options: NestjsMicroservicesPackOptions = {},
): PatternPack {
  const binding: DeclaredBinding = {
    semantics: "message-bus",
    messageBus: options.transport ?? "nats",
    channel: { from: "decoratorArgument", position: 0 },
  };
  return {
    name: "nestjs-microservices",
    languages: ["typescript"],
    protocol: "message-bus",

    discovery: [
      {
        kind: "consumer",
        match: {
          type: "decoratedRoute",
          importModule: ["@nestjs/microservices", "@nestjs/common"],
          classDecorators: ["Controller", ...(options.classDecorators ?? [])],
          // These values only label the handler. The boundary comes from
          // the declared binding.
          methodDecoratorRouteMap: {
            EventPattern: "event",
            MessagePattern: "message",
          },
        },
        binding,
        requiresImport: ["@nestjs/microservices"],
      },
    ],

    terminals: [
      // An `@MessagePattern` handler's return value is the reply, and
      // NestJS drops an `@EventPattern` handler's. Both are recorded as
      // returns, and nothing pairs the reply yet.
      {
        kind: "return",
        match: { type: "returnStatement", excludeCallReturns: false },
        extraction: {},
      },
      {
        kind: "throw",
        match: { type: "throwExpression" },
        extraction: {},
      },
    ],

    inputMapping: {
      type: "decoratedParams",
      decoratorRoleMap: {
        Payload: "message",
        Ctx: "context",
      },
    },
  };
}

export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-nestjs-microservices",
  dependencies: [{ ecosystem: "npm", name: "@nestjs/microservices" }],
  reads:
    "NestJS microservice handlers: \`@EventPattern\` and \`@MessagePattern\` consumers on the channel the decorator states.",
};

export default nestjsMicroservicesFramework;
