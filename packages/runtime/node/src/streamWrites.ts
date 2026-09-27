/**
 * Writes to the process's own output streams. Each one becomes a
 * `stream-write` interaction on an `io` binding that says which stream.
 *
 * `console.log` and its siblings are recognized by how they are spelled,
 * since nothing imports or declares `console`. The target follows Node's
 * own split: `log`, `info`, `debug`, `table` and `dir` go to stdout, and
 * `warn`, `error` and `trace` to stderr. A stream handed in through a
 * parameter is looked up in an answer the store works out once per run.
 * The README has the rest.
 */

import { type CallExpression, Node } from "ts-morph";

import { writtenPayloadOf } from "@suss/adapter-typescript";
import { ioBinding } from "@suss/behavioral-ir";

import type {
  ResolutionStore,
  TsInvocationRecognizerContext,
} from "@suss/adapter-typescript";
import type { Effect } from "@suss/behavioral-ir";
import type { InvocationRecognizer } from "@suss/extractor";

const RECOGNITION = "@suss/runtime-node";

/** The streams `process` has, as a program spells them. */
export const PROCESS_STREAMS = ["process.stdout", "process.stderr"];

const CONSOLE_STREAMS: Readonly<Record<string, string>> = {
  log: "stdout",
  info: "stdout",
  debug: "stdout",
  table: "stdout",
  dir: "stdout",
  warn: "stderr",
  error: "stderr",
  trace: "stderr",
};

/** Annotations that make a parameter something the program prints through. */
const CONSOLE_TYPES = ["Console"];
const STREAM_TYPES = ["NodeJS.WriteStream", "NodeJS.WritableStream"];

export const streamWriteRecognizer: InvocationRecognizer = (call, ctx) => {
  const written = call as CallExpression;
  if (!Node.isCallExpression(written)) {
    return null;
  }
  const callee = written.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) {
    return null;
  }
  const resolution = (ctx as TsInvocationRecognizerContext | undefined)
    ?.resolution;
  const target = targetOf(callee.getExpression(), callee.getName(), resolution);
  if (target === undefined) {
    return null;
  }
  const payload = writtenPayloadOf(written.getArguments());
  const effect: Effect = {
    type: "interaction",
    binding: ioBinding({ recognition: RECOGNITION, target }),
    callee: callee.getText(),
    groupId: callSiteId(written),
    interaction: {
      class: "stream-write",
      payload: payload.shape,
      serialized: payload.serialized,
    },
  };
  return [effect];
};

/**
 * The stream a method call writes to: a name such as `stdout`, null for a
 * stream the source does not settle, or undefined when the call is not a
 * write at all. A parameter annotated as a stream that no caller in the
 * run fills comes back null.
 */
function targetOf(
  receiver: Node,
  method: string,
  resolution: ResolutionStore | undefined,
): string | null | undefined {
  const consoleStream = CONSOLE_STREAMS[method];
  if (consoleStream !== undefined) {
    if (Node.isIdentifier(receiver) && receiver.getText() === "console") {
      return consoleStream;
    }
    return viaParameter(receiver, CONSOLE_TYPES, resolution);
  }

  if (method !== "write") {
    return undefined;
  }
  const spelled = PROCESS_STREAMS.find(
    (stream) => stream === receiver.getText(),
  );
  if (spelled !== undefined) {
    return streamName(spelled);
  }
  const path = viaParameter(receiver, STREAM_TYPES, resolution);
  return path === null || path === undefined ? path : streamName(path);
}

/**
 * Only a bare name can be a parameter the store followed a stream into,
 * so any other receiver is left alone without asking.
 */
function viaParameter(
  receiver: Node,
  annotations: readonly string[],
  resolution: ResolutionStore | undefined,
): string | null | undefined {
  if (resolution === undefined || !Node.isIdentifier(receiver)) {
    return undefined;
  }
  return resolution.streamPathOf(receiver, annotations);
}

/** `process.stdout` writes to `stdout`. */
function streamName(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1);
}

/** Where the call is, which is what tells two writes in one unit apart. */
function callSiteId(call: CallExpression): string {
  const { line, column } = call
    .getSourceFile()
    .getLineAndColumnAtPos(call.getStart());
  return `${line}:${column}`;
}
