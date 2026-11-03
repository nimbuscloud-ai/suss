/**
 * The sends a dependency stub says a project's own dispatcher makes.
 *
 * A service that wraps its queue client never writes the SDK's command,
 * so the SDK declarations never see its sends. A stub says which calls
 * send, in one of two forms: a method called on a receiver of the
 * dispatcher's type, or an export of the module, such as `publishEntry`
 * or `Ledger.append`. Both forms say which arguments are the subject and
 * the body. The subject is the whole channel, and one nothing settles
 * records the send with no channel, the way the SDK sends read theirs.
 *
 * A message-bus pack takes these as its `producers` and passes each one
 * here with its own wire.
 */

import { messageSends } from "./messageSends.js";
import { anyOf, constructedFrom, imported, typed } from "./ops.js";

import type { ConfiguredCallSpec } from "@suss/extractor";
import type { MessageSendsSpec } from "./messageSends.js";
import type { Match } from "./pack.js";

export type { ConfiguredCallSpec } from "@suss/extractor";

type ReceiverSpec = Extract<ConfiguredCallSpec, { receiver: string }>;
type ExportSpec = Exclude<ConfiguredCallSpec, ReceiverSpec>;

/** Which arguments of a matched call the subject and the body are. */
interface Positions {
  readonly subject: number;
  readonly body: number | undefined;
}

/** The declarations for one stated dispatcher, on the pack's wire. */
export function configuredSends(
  spec: ConfiguredCallSpec,
  wire: MessageSendsSpec["wire"],
): Match[] {
  if ("receiver" in spec) {
    return receiverSends(spec, wire);
  }
  return exportSends(spec, wire);
}

/** A method called on a value the program declares as the dispatcher's type. */
function receiverSends(
  spec: ReceiverSpec,
  wire: MessageSendsSpec["wire"],
): Match[] {
  const positions = { subject: spec.subjectArg, body: spec.bodyArg };
  return [
    messageSends({
      ...sendsOn(wire, positions),
      client: typed({ from: [spec.module], named: [spec.receiver] }),
    })
      .methods({ [spec.method]: {} })
      .example(exampleCall(`${spec.receiver}.${spec.method}`, positions)),
  ];
}

/**
 * An export as `suss infer stub` writes it. `publishEntry` is called bare
 * or on the module imported whole. `Ledger.append` is called on an
 * instance the class made or on the class itself, or bare after an import
 * of `append` from the `module/Ledger` sub-path, which the drafter writes
 * into the export the same way. A longer path is not read.
 */
function exportSends(
  spec: ExportSpec,
  wire: MessageSendsSpec["wire"],
): Match[] {
  const positions = { subject: spec.subject.at, body: spec.payload?.at };
  const parts = sendsOn(wire, positions);
  const [head = "", member, ...deeper] = spec.export.split(".");
  if (deeper.length > 0) {
    return [];
  }
  if (member === undefined) {
    return [
      messageSends({
        ...parts,
        client: imported({ from: [spec.module], named: [head] }),
      })
        .calls({})
        .example(exampleCall(head, positions)),
      messageSends({
        ...parts,
        client: imported({ from: [spec.module], named: ["*"] }),
      })
        .methods({ [head]: {} })
        .example(exampleCall(`module.${head}`, positions)),
    ];
  }
  return [
    messageSends({
      ...parts,
      client: anyOf(
        constructedFrom({ from: [spec.module], named: [head] }),
        imported({ from: [spec.module], named: [head] }),
      ),
    })
      .methods({ [member]: {} })
      .example(exampleCall(`${head}.${member}`, positions)),
    messageSends({
      ...parts,
      client: imported({ from: [`${spec.module}/${head}`], named: [member] }),
    })
      .calls({})
      .example(exampleCall(member, positions)),
  ];
}

/** Everything but the client: the call is the message, and the subject its channel. */
function sendsOn(
  wire: MessageSendsSpec["wire"],
  positions: Positions,
): Omit<MessageSendsSpec, "client"> {
  return {
    wire,
    messages: { each: "theCall" },
    channel: [{ argument: { at: positions.subject } }],
    ...(positions.body === undefined
      ? {}
      : { body: { argument: { at: positions.body } } }),
    unsettledName: "nothing",
  };
}

/** A call passing a subject and a body where the stub says they go. */
function exampleCall(callee: string, positions: Positions): string {
  const count = Math.max(positions.subject, positions.body ?? 0) + 1;
  const passed = Array.from({ length: count }, (_, at) =>
    exampleArgument(at, positions),
  );
  return `${callee}(${passed.join(", ")})`;
}

function exampleArgument(at: number, positions: Positions): string {
  if (at === positions.subject) {
    return '"subject"';
  }
  return at === positions.body ? "{}" : "undefined";
}
