# @suss/framework-gcs

Says which Google Cloud Storage buckets and objects a TypeScript service reads and writes.

## What this package is

A pattern pack. It emits the same `storage-access` effects the S3 pack does, so a bucket a service reads from and a bucket a service writes to are the same kind of boundary whichever cloud they are in.

```ts
import { gcsFramework } from "@suss/framework-gcs";

const pack = gcsFramework();
```

A caller reaches an object through a chain rather than through a command object:

```ts
await storage.bucket("reports-prod").file(`reports/${id}.pdf`).download();
```

The operation on the end says whether the call reads or writes, and the chain behind it says which bucket and which object. The pack asks where the operation is declared, so a `download` on something a project wrote is left alone and only the library's own operations count. A step written into a variable first is followed back to where it was built, which is how a repository class keeps one bucket and reaches for a file per call.

## What each part contributes

| Written as | What it becomes |
| --- | --- |
| `.bucket(name)` | the container |
| `.file(path)` | the selector, the object the call addressed |
| the operation on the end | whether the call reads or writes |

A path built from a template becomes a pattern, so `` .file(`${tenantId}/${runId}/pull.json`) `` records `{tenantId}/{runId}/pull.json`. An object has no fields the way a row does, so `fields` is always empty.

Operations that read: `download`, `createReadStream`, `getMetadata`, `exists`, `isPublic`, `getFiles`.

Operations that write: `save`, `upload`, `createWriteStream`, `delete`, `copy`, `move`, `rename`, `setMetadata`, `makePublic`, `makePrivate`.

## A signed URL

`getSignedUrl` hands the caller a URL that reaches the object later, so it counts as an access now. What it does then is whatever the caller signed for:

```ts
.getSignedUrl({ version: "v4", action: "write", expires })   // a write
.getSignedUrl({ version: "v4", action: "read", expires })    // a read
```

A request that says nothing reads as a read, which is what the library does with it.

## A bucket the call site does not know

A storage layer usually takes the bucket and the path as arguments:

```ts
const object = {
  getContent: (location: StorageObjectLocation) =>
    storage.bucket(location.bucket).file(location.path).download(),
};
```

Nothing there says which bucket, so the container comes out null and the access is still recorded. What the boundary is depends on the callers, and pairing a wrapper's callers against the store it reaches is open work.

## Where it fits in suss

Depends on `@suss/behavioral-ir` for the binding it builds and `@suss/adapter-typescript` for the declaration check and for reading a name. The storage pass in `@suss/checker` pairs what this emits against whatever declares the bucket.
