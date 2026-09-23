/**
 * Recognizes Google Cloud Storage calls and records each one as a
 * storage access. A caller reaches an object through a chain,
 * `storage.bucket(name).file(path).download()`, and the method at the
 * end of the chain determines whether it is a read or a write.
 *
 * How many hops back the `bucket` and `file` calls are depends on the
 * operation, so the pack finds each one by its method name and ignores
 * its position in the chain. The README lists the operations and explains
 * how a signed URL counts.
 */

import { declaredBy, pack, storageCalls } from "@suss/recognize";

import type { PackDeclaration } from "@suss/ir-core";
import type {
  ArgumentPick,
  CallStep,
  PatternPack,
  StorageMethod,
} from "@suss/recognize";

const CLIENT_MODULE = "@google-cloud/storage";

const BUCKET_STEP: CallStep = { to: "receiver", method: "bucket" };
const FILE_STEP: CallStep = { to: "receiver", method: "file" };

const OBJECT: ArgumentPick = { of: [FILE_STEP], at: 0 };
const BUCKET: ArgumentPick = { of: [BUCKET_STEP], at: 0 };

const READ: StorageMethod = { kind: "read", selector: OBJECT };
const WRITE: StorageMethod = { kind: "write", selector: OBJECT };

/**
 * A signed URL reaches the object later, for whatever action the caller
 * signed for. A request with no `action` counts as a read, because the
 * library signs it as one.
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
 * An operation counts only when `@google-cloud/storage` declares it, so a
 * `download` method a project wrote is ignored.
 */
export function gcsFramework(): PatternPack {
  return pack("gcs", [CHAIN_CALLS], {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-gcs",
  });
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-gcs",
  dependencies: [{ ecosystem: "npm", name: "@google-cloud/storage" }],
  reads:
    "Google Cloud Storage calls. Each one becomes a storage-access interaction.",
};

export default gcsFramework;
