/**
 * Recognize AWS Secrets Manager calls and emit `storage-access` effects.
 *
 * A secret is a container other units read by name, so it is a store
 * rather than part of the reading unit's own configuration contract.
 * The README beside this file argues that against the alternative.
 *
 * The anchor is the command, wherever a call takes one, the same way
 * the S3 pack reads an object call. A secret's value is one blob with
 * no fields to compare, so what a call says is which secret it reached.
 */

import { constructedFrom, pack, storageCalls } from "@suss/recognize";

import type {
  ArgumentPick,
  CallStep,
  PatternPack,
  StorageMethod,
} from "@suss/recognize";

/** The module a command class comes from. */
const COMMAND_MODULE = "@aws-sdk/client-secrets-manager";

/** The command a call was handed, wherever the call takes it. */
const COMMAND: CallStep = { to: "argument", at: { from: 0 } };

/**
 * Which secret the command reached. Most commands address it by id and
 * a create addresses it by the name it is giving it, and both are the
 * one secret.
 */
const SECRET: ArgumentPick = { at: 0, property: ["SecretId", "Name"] };

/** Where a call that reads several secrets at once lists them. */
const SECRETS: ArgumentPick = { at: 0, property: ["SecretIdList"] };

const READ_SECRET: StorageMethod = { kind: "read" };
const WRITE_SECRET: StorageMethod = { kind: "write" };

/** Every command this reads, and whether it reads or writes. */
const COMMANDS: Record<string, StorageMethod> = {
  GetSecretValueCommand: READ_SECRET,
  BatchGetSecretValueCommand: READ_SECRET,
  CreateSecretCommand: WRITE_SECRET,
  PutSecretValueCommand: WRITE_SECRET,
  UpdateSecretCommand: WRITE_SECRET,
  DeleteSecretCommand: WRITE_SECRET,
};

const SECRET_CALLS = storageCalls({
  system: "aws.secretsmanager",
  transport: "aws-sdk",
  client: constructedFrom(COMMAND_MODULE),
})
  .about(COMMAND)
  .methods(COMMANDS)
  .container(SECRET)
  .containersIn(SECRETS, { each: "name" })
  .example(
    'client.send(new GetSecretValueCommand({ SecretId: "prod/db/password" }))',
  );

/**
 * Pack export. One declaration, gated on a file importing the Secrets
 * Manager client, which is where a command class can come from.
 */
export function secretsManagerFramework(): PatternPack {
  return pack("aws-secrets-manager", [SECRET_CALLS], {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-aws-secrets-manager",
    protocol: "aws.secretsmanager",
  });
}

export default secretsManagerFramework;
