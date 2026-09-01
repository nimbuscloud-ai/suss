/**
 * queueShape.ts: a queue consumer, written twelve ways.
 *
 * Nothing in a Lambda's source says which queue feeds it, so the
 * template declares the event source and a program here is two files:
 * the template and the handler. What varies is how the service builds
 * the exported handler, through a factory of its own or not, and all
 * twelve have to come out as one consumer unit behind the same bus.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type DispatchTable, dispatchByType } from "../dispatch.js";

/** How the exported handler is built. */
export type ConsumerBuild =
  | "factoryConfigFirst"
  | "factoryConfigSecond"
  | "configThroughVariable"
  | "spreadIntoConfig"
  | "asConstSubject"
  | "factoryThroughAlias"
  | "subjectFromConst"
  | "subjectFromSharedMap"
  | "spreadCarriesSubject"
  | "wrappedFactoryResult"
  | "reexportedHandler"
  | "bareFunction";

export interface QueueShapeSpec {
  build: ConsumerBuild;
}

export const SIMPLEST_QUEUE_SHAPE: QueueShapeSpec = {
  build: "factoryConfigFirst",
};

export const SUBJECT = "widget.created";
const SUBJECT_PROPERTY = "subject";
const FACTORY_NAME = "makeHandler";

/**
 * The template points at a handler by file path, so this family writes
 * files rather than keeping them in memory. One directory per process
 * keeps parallel test workers off each other's files.
 */
export const queueProjectRoot = (): string =>
  path.join(os.tmpdir(), `suss-differential-queue-${process.pid}`);

const TEMPLATE = `AWSTemplateFormatVersion: "2010-09-09"
Transform: AWS::Serverless-2016-10-31
Resources:
  WidgetQueue:
    Type: AWS::SQS::Queue
  ConsumerFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: .
      Handler: src/consumer.handler
      Events:
        Widgets:
          Type: SQS
          Properties:
            Queue: !GetAtt WidgetQueue.Arn
`;

// The service's own consumer factory, in the shape a message consumer
// takes: a config naming the subject, and the body run per message.
const FACTORY_SOURCE = `export interface ConsumerConfig {
  subject: string;
}

export function ${FACTORY_NAME}(
  config: ConsumerConfig,
  body: (args: { parsed: unknown }) => Promise<void>,
) {
  return async (event: { Records: Array<{ body: string }> }): Promise<void> => {
    for (const record of event.Records) {
      await body({ parsed: JSON.parse(record.body) });
    }
    void config;
  };
}

export function ${FACTORY_NAME}Flipped(
  body: (args: { parsed: unknown }) => Promise<void>,
  config: ConsumerConfig,
) {
  return ${FACTORY_NAME}(config, body);
}
`;

// The build the re-exporting consumer points at. The consumer is the
// only file the template mentions, so this one is reached only through
// that re-export.
const WORKER_SOURCE = `import { ${FACTORY_NAME} } from "./makeHandler.js";

export const handler = ${FACTORY_NAME}(
  { ${SUBJECT_PROPERTY}: ${JSON.stringify(SUBJECT)} },
  async ({ parsed }) => {
    void parsed;
  },
);
`;

const BODY = ["  async ({ parsed }) => {", "    void parsed;", "  },"];

interface ConsumerRendering {
  source: string;
}

const importLine = (names: string[]): string =>
  `import { ${names.join(", ")} } from "./makeHandler.js";`;

const consumerRenderings: DispatchTable<
  { type: ConsumerBuild },
  ConsumerRendering
> = {
  factoryConfigFirst: () => ({
    source: [
      importLine([FACTORY_NAME]),
      "",
      `export const handler = ${FACTORY_NAME}(`,
      `  { ${SUBJECT_PROPERTY}: ${JSON.stringify(SUBJECT)} },`,
      ...BODY,
      ");",
      "",
    ].join("\n"),
  }),
  factoryConfigSecond: () => ({
    source: [
      importLine([`${FACTORY_NAME}Flipped`]),
      "",
      `export const handler = ${FACTORY_NAME}Flipped(`,
      ...BODY,
      `  { ${SUBJECT_PROPERTY}: ${JSON.stringify(SUBJECT)} },`,
      ");",
      "",
    ].join("\n"),
  }),
  configThroughVariable: () => ({
    source: [
      importLine([FACTORY_NAME]),
      "",
      `const config = { ${SUBJECT_PROPERTY}: ${JSON.stringify(SUBJECT)} };`,
      "",
      `export const handler = ${FACTORY_NAME}(`,
      "  config,",
      ...BODY,
      ");",
      "",
    ].join("\n"),
  }),
  spreadIntoConfig: () => ({
    source: [
      importLine([FACTORY_NAME]),
      "",
      'const base = { name: "widget-consumer" };',
      "",
      `export const handler = ${FACTORY_NAME}(`,
      `  { ...base, ${SUBJECT_PROPERTY}: ${JSON.stringify(SUBJECT)} },`,
      ...BODY,
      ");",
      "",
    ].join("\n"),
  }),
  asConstSubject: () => ({
    source: [
      importLine([FACTORY_NAME]),
      "",
      `export const handler = ${FACTORY_NAME}(`,
      `  { ${SUBJECT_PROPERTY}: ${JSON.stringify(SUBJECT)} as const },`,
      ...BODY,
      ");",
      "",
    ].join("\n"),
  }),
  factoryThroughAlias: () => ({
    source: [
      importLine([FACTORY_NAME]),
      "",
      `const build = ${FACTORY_NAME};`,
      "",
      "export const handler = build(",
      `  { ${SUBJECT_PROPERTY}: ${JSON.stringify(SUBJECT)} },`,
      ...BODY,
      ");",
      "",
    ].join("\n"),
  }),
  subjectFromConst: () => ({
    source: [
      importLine([FACTORY_NAME]),
      "",
      `const subject = ${JSON.stringify(SUBJECT)};`,
      "",
      `export const handler = ${FACTORY_NAME}(`,
      `  { ${SUBJECT_PROPERTY}: subject },`,
      ...BODY,
      ");",
      "",
    ].join("\n"),
  }),
  // The subjects a service publishes and consumes, kept in one place,
  // which is where a service with more than two of them puts them.
  subjectFromSharedMap: () => ({
    source: [
      importLine([FACTORY_NAME]),
      "",
      `const subjects = { widget: ${JSON.stringify(SUBJECT)} } as const;`,
      "",
      `export const handler = ${FACTORY_NAME}(`,
      `  { ${SUBJECT_PROPERTY}: subjects.widget },`,
      ...BODY,
      ");",
      "",
    ].join("\n"),
  }),
  spreadCarriesSubject: () => ({
    source: [
      importLine([FACTORY_NAME]),
      "",
      `const base = { ${SUBJECT_PROPERTY}: ${JSON.stringify(SUBJECT)} };`,
      "",
      `export const handler = ${FACTORY_NAME}(`,
      "  { ...base },",
      ...BODY,
      ");",
      "",
    ].join("\n"),
  }),
  wrappedFactoryResult: () => ({
    source: [
      importLine([FACTORY_NAME]),
      "",
      "const withLogging = <T>(inner: T): T => inner;",
      "",
      `export const handler = withLogging(${FACTORY_NAME}(`,
      `  { ${SUBJECT_PROPERTY}: ${JSON.stringify(SUBJECT)} },`,
      ...BODY,
      "));",
      "",
    ].join("\n"),
  }),
  // The consumer file the template points at contains the export, and
  // the build lives next to it, which is how a service keeps its
  // handlers one line each.
  reexportedHandler: () => ({
    source: ['export { handler } from "./worker.js";', ""].join("\n"),
  }),
  // No factory at all, so the export is the handler itself.
  bareFunction: () => ({
    source: [
      "export const handler = async (event: { Records: Array<{ body: string }> }): Promise<void> => {",
      "  for (const record of event.Records) {",
      "    void JSON.parse(record.body);",
      "  }",
      "};",
      "",
    ].join("\n"),
  }),
};

export interface RenderedQueueShape {
  /** Absolute path to content, for every file the program spans. */
  files: Record<string, string>;
  root: string;
}

export function renderQueueShape(spec: QueueShapeSpec): RenderedQueueShape {
  const rendering = dispatchByType(consumerRenderings, { type: spec.build });
  const root = queueProjectRoot();
  return {
    files: {
      [path.join(root, "template.yaml")]: TEMPLATE,
      [path.join(root, "src", "makeHandler.ts")]: FACTORY_SOURCE,
      [path.join(root, "src", "worker.ts")]: WORKER_SOURCE,
      [path.join(root, "src", "consumer.ts")]: rendering.source,
    },
    root,
  };
}

/** Put a rendered program where the template resolution can see it. */
export function writeQueueShape(rendered: RenderedQueueShape): void {
  fs.mkdirSync(path.join(rendered.root, "src"), { recursive: true });
  for (const [filePath, content] of Object.entries(rendered.files)) {
    fs.writeFileSync(filePath, content);
  }
}
