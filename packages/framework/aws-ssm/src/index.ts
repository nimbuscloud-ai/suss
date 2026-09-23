/**
 * Recognizes AWS SSM Parameter Store calls and records each one as a
 * storage access on the parameter it reached. A parameter is a single
 * value with no fields, so the access records the parameter name and
 * nothing about its contents.
 *
 * The README explains why a parameter counts as a store instead of
 * runtime config, and which commands are left out.
 */

import { constructedFrom, pack, storageCalls } from "@suss/recognize";

import type { PackDeclaration } from "@suss/ir-core";
import type {
  ArgumentPick,
  CallStep,
  PatternPack,
  StorageMethod,
} from "@suss/recognize";

const COMMAND_MODULE = "@aws-sdk/client-ssm";

const COMMAND: CallStep = { to: "argument", at: { from: 0 } };

const PARAMETER: ArgumentPick = { at: 0, property: ["Name"] };

const PARAMETERS: ArgumentPick = { at: 0, property: ["Names"] };

const READ_PARAMETER: StorageMethod = { kind: "read" };
const WRITE_PARAMETER: StorageMethod = { kind: "write" };

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
 * A command counts only when its class is imported from the SSM client,
 * so a class with the same name from another module is ignored.
 */
export function ssmFramework(): PatternPack {
  return pack("aws-ssm", [PARAMETER_CALLS], {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-aws-ssm",
    protocol: "aws.ssm",
  });
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-aws-ssm",
  dependencies: [{ ecosystem: "npm", name: "@aws-sdk/client-ssm" }],
  reads:
    "AWS SSM Parameter Store calls. Each one becomes a storage-access interaction on the parameter.",
};

export default ssmFramework;
