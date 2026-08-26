// producerShape.ts: a queue producer, and the ways code says which
// queue it sends to.
//
// The property this family checks: however the queue is named, the send
// is recorded. A name the code states (a literal, an env var, a const
// here or in another file) reaches the channel. A name the program
// cannot state (a parameter, a computed string) leaves the channel
// null, and the send is still there. Losing the send whole is the bug
// class this family exists to catch; it shipped three times before the
// fuzzer covered it.

import { type DispatchTable, dispatchByType } from "../dispatch.js";

import type { PatternPack } from "@suss/extractor";

/** How the program says which queue it sends to. */
export type ProducerNaming =
  | "literalUrl"
  | "envVar"
  | "constSameFile"
  | "constImported"
  | "templateString"
  | "parameter";

export const PRODUCER_NAMINGS: ProducerNaming[] = [
  "literalUrl",
  "envVar",
  "constSameFile",
  "constImported",
  "templateString",
  "parameter",
];

export interface ProducerShapeSpec {
  naming: ProducerNaming;
}

export const SIMPLEST_PRODUCER_SHAPE: ProducerShapeSpec = {
  naming: "literalUrl",
};

const QUEUE_URL =
  "https://sqs.us-east-1.amazonaws.com/123456789012/WidgetQueue";
const ENV_VAR = "WIDGET_QUEUE_URL";

export interface RenderedProducerShape {
  files: Record<string, string>;
  /** The channel the summary should have, or null when the source says
   * nothing about it. */
  expectedChannel: string | null;
}

// The SDK's type surface, so the import check has a package to point
// at. Same shape the pack's own tests stub.
const SDK_FILES: Record<string, string> = {
  "node_modules/@aws-sdk/client-sqs/package.json": JSON.stringify({
    name: "@aws-sdk/client-sqs",
    types: "index.d.ts",
  }),
  "node_modules/@aws-sdk/client-sqs/index.d.ts": `
export class SQSClient {
  constructor(config?: unknown);
  send(command: unknown): Promise<unknown>;
}
export class SendMessageCommand {
  constructor(input: { QueueUrl?: unknown; MessageBody?: unknown });
}
`,
};

const PRELUDE = [
  'import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";',
  "",
  "const client = new SQSClient({});",
  "",
];

/** The handler around one send, with the QueueUrl expression filled in. */
function handlerSending(queueUrlExpression: string, lines: string[] = []) {
  return [
    ...PRELUDE,
    ...lines,
    "export async function handler(event: { id: string }): Promise<{ ok: boolean }> {",
    "  await client.send(",
    "    new SendMessageCommand({",
    `      QueueUrl: ${queueUrlExpression},`,
    "      MessageBody: JSON.stringify({ id: event.id }),",
    "    }),",
    "  );",
    "  return { ok: true };",
    "}",
    "",
  ].join("\n");
}

const renderings: DispatchTable<
  { type: ProducerNaming },
  RenderedProducerShape
> = {
  literalUrl: () => ({
    files: { "user.ts": handlerSending(JSON.stringify(QUEUE_URL)) },
    expectedChannel: QUEUE_URL,
  }),
  envVar: () => ({
    files: { "user.ts": handlerSending(`process.env.${ENV_VAR}`) },
    // The reference spelling, which grounding reads. The bare name was
    // a private spelling only the message-bus checker knew.
    expectedChannel: `{${ENV_VAR}}`,
  }),
  constSameFile: () => ({
    files: {
      "user.ts": handlerSending("queueUrl", [
        `const queueUrl = ${JSON.stringify(QUEUE_URL)};`,
        "",
      ]),
    },
    expectedChannel: QUEUE_URL,
  }),
  constImported: () => ({
    files: {
      "config.ts": `export const QUEUE_URL = ${JSON.stringify(QUEUE_URL)};\n`,
      "user.ts": [
        'import { QUEUE_URL } from "./config.js";',
        "",
        handlerSending("QUEUE_URL"),
      ].join("\n"),
    },
    expectedChannel: QUEUE_URL,
  }),
  templateString: () => ({
    files: {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the string is TypeScript source for the generated program, and the template is what the case exercises.
      "user.ts": handlerSending("`${base}/WidgetQueue`", [
        'const base = "https://sqs.us-east-1.amazonaws.com/123456789012";',
        "",
      ]),
    },
    // The template's one hole is a const with a literal, so the ops
    // put it back together. The hand-rolled reader recorded null here.
    expectedChannel: QUEUE_URL,
  }),
  parameter: () => ({
    files: {
      "user.ts": [
        ...PRELUDE,
        "export async function handler(event: { id: string; queueUrl: string }): Promise<{ ok: boolean }> {",
        "  await client.send(",
        "    new SendMessageCommand({",
        "      QueueUrl: event.queueUrl,",
        "      MessageBody: JSON.stringify({ id: event.id }),",
        "    }),",
        "  );",
        "  return { ok: true };",
        "}",
        "",
      ].join("\n"),
    },
    // A caller passes the queue, so a caller can ground it. The
    // channel keeps the reference for whoever knows.
    expectedChannel: "{event.queueUrl}",
  }),
};

export function renderProducerShape(
  spec: ProducerShapeSpec,
): RenderedProducerShape {
  const rendered = dispatchByType(renderings, { type: spec.naming });
  return { ...rendered, files: { ...SDK_FILES, ...rendered.files } };
}

/**
 * Finds the exported handler so the send inside it lands in a summary.
 * The sqs pack only recognizes calls; something has to own the unit.
 */
export const PRODUCER_HANDLER_PACK: PatternPack = {
  name: "producer-shape:handler",
  protocol: "in-process",
  languages: ["typescript"],
  discovery: [
    {
      kind: "handler",
      match: { type: "namedExport", names: ["handler"] },
      requiresImport: [],
    },
  ],
  terminals: [
    { kind: "return", match: { type: "returnStatement" }, extraction: {} },
    { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
  ],
  inputMapping: {
    type: "positionalParams",
    params: [{ position: 0, role: "event" }],
  },
};
