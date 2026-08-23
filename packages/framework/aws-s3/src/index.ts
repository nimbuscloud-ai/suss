/**
 * Recognize S3 object calls and emit `storage-access` effects.
 *
 * The anchor is the command, wherever a call takes one. `send` runs it
 * now and `getSignedUrl` hands back a URL that runs it later, and both
 * address the same object. So the chain is about the command rather
 * than the call that was handed it: the method is `send` everywhere,
 * and the command says which operation, which bucket and which key.
 *
 * A bucket's objects have no fields to compare a read against, so what
 * a call says is the key it addressed. A key built from a template
 * becomes a pattern, `uploads/{tenant}/{id}`, which is the shape a
 * bucket's key convention would be compared against.
 */

import { constructedFrom, pack, storageCalls } from "@suss/recognize";

import type {
  ArgumentPick,
  CallStep,
  PatternPack,
  StorageMethod,
} from "@suss/recognize";

/** The module a command class comes from. */
const COMMAND_MODULE = "@aws-sdk/client-s3";

/**
 * The command a call was handed, wherever the call takes it. `send`
 * takes it first and the presigner takes it second.
 */
const COMMAND: CallStep = { to: "argument", at: { from: 0 } };

/**
 * What the command addressed. A listing states a prefix where an
 * item-level command states a key, and either is the part of the bucket
 * the call reached.
 */
const ADDRESSED: ArgumentPick = { at: 0, property: ["Key", "Prefix"] };

/** Which bucket the command reached. */
const BUCKET: ArgumentPick = { at: 0, property: ["Bucket"] };

const READ_OBJECT: StorageMethod = { kind: "read", selector: ADDRESSED };
const WRITE_OBJECT: StorageMethod = { kind: "write", selector: ADDRESSED };

/** Every command this reads, and whether it reads or writes. */
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
 * Pack export. One declaration, gated on a file importing the S3
 * client, which is where a command class can come from.
 */
export function s3Framework(): PatternPack {
  return pack("aws-s3", [OBJECT_CALLS], {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-aws-s3",
    protocol: "s3",
  });
}

export default s3Framework;
