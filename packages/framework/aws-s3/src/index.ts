/**
 * Recognizes S3 object calls and records each one as a storage access
 * on the bucket, with the key the call addressed.
 *
 * The pack matches on the command object. `send` runs a command now and
 * `getSignedUrl` returns a URL that runs it later, and both reach the
 * same object, so the operation, bucket and key all come from the
 * command. The README covers how keys built from templates are recorded.
 */

import { constructedFrom, pack, storageCalls } from "@suss/recognize";

import type { PackDeclaration } from "@suss/ir-core";
import type {
  ArgumentPick,
  CallStep,
  PatternPack,
  StorageMethod,
} from "@suss/recognize";

const COMMAND_MODULE = "@aws-sdk/client-s3";

/** `send` takes the command first and `getSignedUrl` takes it second. */
const COMMAND: CallStep = { to: "argument", at: { from: 0 } };

/** A listing gives a `Prefix` where a command on one object gives a `Key`. */
const ADDRESSED: ArgumentPick = { at: 0, property: ["Key", "Prefix"] };

const BUCKET: ArgumentPick = { at: 0, property: ["Bucket"] };

const READ_OBJECT: StorageMethod = { kind: "read", selector: ADDRESSED };
const WRITE_OBJECT: StorageMethod = { kind: "write", selector: ADDRESSED };

const COMMANDS: Record<string, StorageMethod> = {
  GetObjectCommand: READ_OBJECT,
  HeadObjectCommand: READ_OBJECT,
  ListObjectsV2Command: READ_OBJECT,
  ListObjectsCommand: READ_OBJECT,
  PutObjectCommand: WRITE_OBJECT,
  DeleteObjectCommand: WRITE_OBJECT,
  DeleteObjectsCommand: WRITE_OBJECT,
  CopyObjectCommand: WRITE_OBJECT,
  // A large object goes up in parts, and each command in that sequence
  // writes the same object.
  CreateMultipartUploadCommand: WRITE_OBJECT,
  UploadPartCommand: WRITE_OBJECT,
  CompleteMultipartUploadCommand: WRITE_OBJECT,
  AbortMultipartUploadCommand: WRITE_OBJECT,
};

const OBJECT_CALLS = storageCalls({
  system: "s3",
  transport: "aws-sdk",
  client: constructedFrom(COMMAND_MODULE),
})
  .about(COMMAND)
  .methods(COMMANDS)
  .container(BUCKET)
  .example('s3.send(new GetObjectCommand({ Bucket: "photos", Key: "a.jpg" }))');

/**
 * A command counts only when its class is imported from the S3 client,
 * so a class with the same name from another module is ignored.
 */
export function s3Framework(): PatternPack {
  return pack("aws-s3", [OBJECT_CALLS], {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-aws-s3",
    protocol: "s3",
  });
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-aws-s3",
  dependencies: [{ ecosystem: "npm", name: "@aws-sdk/client-s3" }],
  reads:
    "AWS SDK v3 S3 object calls. Each one becomes a storage-access interaction.",
};

export default s3Framework;
