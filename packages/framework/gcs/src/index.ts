/**
 * Recognize Google Cloud Storage calls and emit `storage-access`
 * effects.
 *
 * A caller reaches an object through a chain rather than a command:
 * `storage.bucket(name).file(path).download()`. The operation at the
 * end says whether it reads or writes, and the chain behind it says
 * which bucket and which object. Those two hops are a different
 * distance back depending on the operation, so each is stated as the
 * step up the receivers that reaches it rather than as a position.
 *
 * The README says which operations it reads and what a signed URL
 * counts as.
 */

import { declaredBy, pack, storageCalls } from "@suss/recognize";

import type {
  ArgumentPick,
  CallStep,
  PatternPack,
  StorageMethod,
} from "@suss/recognize";

/** The library a call has to come from. */
const CLIENT_MODULE = "@google-cloud/storage";

/** The calls in the chain that say what the operation is addressing. */
const BUCKET_STEP: CallStep = { to: "receiver", method: "bucket" };
const FILE_STEP: CallStep = { to: "receiver", method: "file" };

/** Which object the operation reached, and which bucket it is in. */
const OBJECT: ArgumentPick = { of: [FILE_STEP], at: 0 };
const BUCKET: ArgumentPick = { of: [BUCKET_STEP], at: 0 };

const READ: StorageMethod = { kind: "read", selector: OBJECT };
const WRITE: StorageMethod = { kind: "write", selector: OBJECT };

/**
 * A signed URL reaches the object later, and what it does then is
 * whatever the caller asked to sign for. A request that says nothing
 * signs for a read, which is what the library does with it.
 */
const SIGNED_URL: StorageMethod = {
  kind: {
    asks: { at: 0, property: ["action"] },
    means: {
      read: "read",
      write: "write",
      delete: "write",
      resumable: "write",
    },
    otherwise: "read",
  },
  selector: OBJECT,
};

/** Every operation this reads, and whether it reads or writes. */
const OPERATIONS: Record<string, StorageMethod> = {
  download: READ,
  createReadStream: READ,
  getMetadata: READ,
  exists: READ,
  isPublic: READ,
  getFiles: READ,
  save: WRITE,
  upload: WRITE,
  createWriteStream: WRITE,
  delete: WRITE,
  copy: WRITE,
  move: WRITE,
  rename: WRITE,
  setMetadata: WRITE,
  makePublic: WRITE,
  makePrivate: WRITE,
  getSignedUrl: SIGNED_URL,
};

const CHAIN_CALLS = storageCalls({
  system: "gcs",
  client: declaredBy(CLIENT_MODULE),
})
  .methods(OPERATIONS)
  .container(BUCKET)
  .example('storage.bucket("uploads").file("reports/a.pdf").download()');

/**
 * Pack export. One declaration, gated on a file reaching the client
 * library, which is where an operation can come from.
 */
export function gcsFramework(): PatternPack {
  return pack("gcs", [CHAIN_CALLS], {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-gcs",
  });
}

export default gcsFramework;
