// queueShape.ts: a queue consumer, and the configuration that says how
// to read it.
//
// Nothing in a Lambda's source says which queue feeds it: the template
// declares the event source, and the subject the consumer answers to
// sits in whatever config object the service's own factory takes. So a
// program in this family is three things, and all three are generated:
// the template, the handler, and the pack options that name the
// factory's config property. The subject reaching the summary is what
// lets a producer pair with the consumer, so that is what the oracles
// hold.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type DispatchTable, dispatchByType } from "../dispatch.js";

import type { SubjectFactory } from "@suss/framework-aws-lambda";

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

/**
 * How the project writes the pack option that finds the subject. All
 * three describe the same factory, so all three should read the same
 * program the same way.
 */
export type ConfigStyle = "propertyOnly" | "namedCallee" | "argIndexed";

export interface QueueShapeSpec {
  build: ConsumerBuild;
  config: ConfigStyle;
}

export const SIMPLEST_QUEUE_SHAPE: QueueShapeSpec = {
  build: "factoryConfigFirst",
  config: "propertyOnly",
};

export const SUBJECT = "widget.created";
const SUBJECT_PROPERTY = "subject";
const FACTORY_NAME = "makeHandler";

/**
 * The template names a handler by file path, so this family writes
 * files rather than holding them in memory. One directory per process
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

// The build the re-exporting consumer points at. The template names no
// file but the consumer, so this one is only reached through that
// re-export.
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
  /** Where the config object sits in the factory's arguments. */
  argIndex: number;
  /** The callee the factory is written as. */
  callee: string;
  /** The subject the consumer answers, when it names one. */
  channel: string | null;
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
    argIndex: 0,
    callee: FACTORY_NAME,
    channel: SUBJECT,
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
    argIndex: 1,
    callee: `${FACTORY_NAME}Flipped`,
    channel: SUBJECT,
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
    argIndex: 0,
    callee: FACTORY_NAME,
    channel: SUBJECT,
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
    argIndex: 0,
    callee: FACTORY_NAME,
    channel: SUBJECT,
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
    argIndex: 0,
    callee: FACTORY_NAME,
    channel: SUBJECT,
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
    argIndex: 0,
    callee: "build",
    channel: SUBJECT,
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
    argIndex: 0,
    callee: FACTORY_NAME,
    channel: SUBJECT,
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
    argIndex: 0,
    callee: FACTORY_NAME,
    channel: SUBJECT,
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
    argIndex: 0,
    callee: FACTORY_NAME,
    channel: SUBJECT,
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
    argIndex: 0,
    callee: FACTORY_NAME,
    channel: SUBJECT,
  }),
  // The consumer file the template names holds the export and the
  // build sits next to it, which is how a service keeps its handlers
  // one line each.
  reexportedHandler: () => ({
    source: ['export { handler } from "./worker.js";', ""].join("\n"),
    argIndex: 0,
    callee: FACTORY_NAME,
    channel: SUBJECT,
  }),
  // No factory, so the source names no subject and the consumer keeps
  // whatever the template gives it.
  bareFunction: () => ({
    source: [
      "export const handler = async (event: { Records: Array<{ body: string }> }): Promise<void> => {",
      "  for (const record of event.Records) {",
      "    void JSON.parse(record.body);",
      "  }",
      "};",
      "",
    ].join("\n"),
    argIndex: 0,
    callee: FACTORY_NAME,
    channel: null,
  }),
};

/** The pack options a project would write for the program it has. */
function subjectFactoryFor(
  spec: QueueShapeSpec,
  rendering: ConsumerRendering,
): SubjectFactory {
  const table: DispatchTable<{ type: ConfigStyle }, SubjectFactory> = {
    propertyOnly: () => ({ property: SUBJECT_PROPERTY }),
    namedCallee: () => ({
      property: SUBJECT_PROPERTY,
      callees: [rendering.callee],
    }),
    argIndexed: () => ({
      property: SUBJECT_PROPERTY,
      argIndex: rendering.argIndex,
    }),
  };
  return dispatchByType(table, { type: spec.config });
}

export interface RenderedQueueShape {
  /** Absolute path to content, for every file the program spans. */
  files: Record<string, string>;
  /** The pack options the project ships alongside the program. */
  subjectFactories: SubjectFactory[];
  /** The subject the program says this consumer answers. */
  channel: string | null;
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
    subjectFactories: [subjectFactoryFor(spec, rendering)],
    channel: rendering.channel,
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
