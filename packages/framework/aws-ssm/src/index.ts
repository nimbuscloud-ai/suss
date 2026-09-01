/**
 * Recognize AWS SSM Parameter Store calls and emit `storage-access`
 * effects.
 *
 * A parameter is a container other units read by name, so it is a store
 * rather than part of the reading unit's own configuration contract.
 * The README beside this file argues that against the alternative.
 *
 * The anchor is the command, wherever a call takes one, the same way
 * the S3 pack reads an object call. A parameter is one value with no
 * fields to compare, so what a call says is which parameter it reached.
 */

import { constructedFrom, pack, storageCalls } from "@suss/recognize";

import type {
  ArgumentPick,
  CallStep,
  PatternPack,
  StorageMethod,
} from "@suss/recognize";

/** The module a command class comes from. */
const COMMAND_MODULE = "@aws-sdk/client-ssm";

/** The command a call was handed, wherever the call takes it. */
const COMMAND: CallStep = { to: "argument", at: { from: 0 } };

/** Which parameter the command reached. */
const PARAMETER: ArgumentPick = { at: 0, property: ["Name"] };

/** Where a call that reaches several parameters at once lists them. */
const PARAMETERS: ArgumentPick = { at: 0, property: ["Names"] };

const READ_PARAMETER: StorageMethod = { kind: "read" };
const WRITE_PARAMETER: StorageMethod = { kind: "write" };

/** Every command this reads, and whether it reads or writes. */
const COMMANDS: Record<string, StorageMethod> = {
  GetParameterCommand: READ_PARAMETER,
  GetParametersCommand: READ_PARAMETER,
  PutParameterCommand: WRITE_PARAMETER,
  DeleteParameterCommand: WRITE_PARAMETER,
  DeleteParametersCommand: WRITE_PARAMETER,
};

const PARAMETER_CALLS = storageCalls({
  system: "aws.ssm",
  transport: "aws-sdk",
  client: constructedFrom(COMMAND_MODULE),
})
  .about(COMMAND)
  .methods(COMMANDS)
  .container(PARAMETER)
  .containersIn(PARAMETERS, { each: "name" })
  .example('client.send(new GetParameterCommand({ Name: "/prod/db/host" }))');

/**
 * Pack export. One declaration, gated on a file importing the SSM
 * client, which is where a command class can come from.
 */
export function ssmFramework(): PatternPack {
  return pack("aws-ssm", [PARAMETER_CALLS], {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-aws-ssm",
    protocol: "aws.ssm",
  });
}

export default ssmFramework;
