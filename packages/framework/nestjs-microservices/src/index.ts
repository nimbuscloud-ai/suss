// @suss/framework-nestjs-microservices: the PatternPack for NestJS
// microservice handlers (`@nestjs/microservices`).
//
// A microservice handler is a method on a `@Controller()` class
// decorated with `@EventPattern("order.placed")` or
// `@MessagePattern("get.order")`. The decorator's argument is the
// channel, and the transport (NATS, Kafka, Redis, and the rest) is
// wired at bootstrap, so the source states the channel and the project
// states the wire.
//
// This is the first pack on a declared binding: the same decorator
// discovery the REST pack uses, with the boundary stated on the
// pattern instead of read as a route. The handler pairs against
// whatever produces on the same channel.
//
// The wire defaults to NATS and a project on another transport says so
// through pack config (`-f nestjs-microservices=config.json` with
// `{ "transport": "kafka" }`), because nothing in the handler's file
// says which broker bootstrap picked.
//
// Deferred:
//   - `@Payload("field")` narrowing: every payload lands as one input.
//   - Reply pairing for `@MessagePattern` (request/reply is a second
//     boundary the reply side states nowhere readable yet).
//   - Object-form patterns, `@MessagePattern({ cmd: "sum" })`: the
//     channel is a structured key and v0 reads only strings.

import { z } from "zod";

import type { DeclaredBinding, PatternPack } from "@suss/extractor";

/** The wires NestJS ships transports for that suss can spell. */
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
 * What `-f nestjs-microservices=config.json` may say. The CLI parses the file against it
 * before the factory runs.
 */
export const optionsSchema = z
  .object({
    /**
     * The broker bootstrap connects, which the handler's own file never
     * states. Defaults to NATS.
     */
    transport: z.enum(TRANSPORTS).optional(),
    /**
     * Class decorators this project composes `@Controller()` into, the
     * same escape the REST pack takes for wrappers whose body is not in
     * the project.
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
          // The values label the handler for a reader; the boundary
          // comes from the declared binding below.
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
      // An @MessagePattern handler's return is the reply; an
      // @EventPattern handler's return is dropped by the framework.
      // Both are recorded as returns, and reply pairing is deferred.
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

export default nestjsMicroservicesFramework;
