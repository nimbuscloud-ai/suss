/**
 * Recognizes AWS Secrets Manager calls and records each one as a storage
 * access on the secret it reached. A secret's value is a single blob
 * with no fields, so the access records the secret and nothing about
 * its contents.
 *
 * The README explains why a secret counts as a store instead of runtime
 * config.
 */

import { constructedFrom, pack, storageCalls } from "@suss/recognize";

import type { PackDeclaration } from "@suss/ir-core";
import type {
  ArgumentPick,
  CallStep,
  PatternPack,
  StorageMethod,
} from "@suss/recognize";

const COMMAND_MODULE = "@aws-sdk/client-secrets-manager";

const COMMAND: CallStep = { to: "argument", at: { from: 0 } };

/**
 * A create gives the new secret's `Name`, and the other commands give
 * the `SecretId`.
 */
const SECRET: ArgumentPick = { at: 0, property: ["SecretId", "Name"] };

const SECRETS: ArgumentPick = { at: 0, property: ["SecretIdList"] };

const READ_SECRET: StorageMethod = { kind: "read" };
const WRITE_SECRET: StorageMethod = { kind: "write" };

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
 * A command counts only when its class is imported from the Secrets
 * Manager client, so a class with the same name from another module is
 * ignored.
 */
export function secretsManagerFramework(): PatternPack {
  return pack("aws-secrets-manager", [SECRET_CALLS], {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-aws-secrets-manager",
    protocol: "aws.secretsmanager",
  });
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-aws-secrets-manager",
  dependencies: [{ ecosystem: "npm", name: "@aws-sdk/client-secrets-manager" }],
  reads:
    "AWS Secrets Manager calls. Each one becomes a storage-access interaction on the secret.",
};

export default secretsManagerFramework;
