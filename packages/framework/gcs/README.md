# @suss/framework-gcs

This pack records which Google Cloud Storage buckets and objects a TypeScript service reads and writes.

## What this package is

A pattern pack. It records the same `storage-access` effects the S3 pack does, so a bucket a service reads from or writes to is the same kind of boundary whichever cloud it is in.

```ts
import { gcsFramework } from "@suss/framework-gcs";

const pack = gcsFramework();
```

A caller reaches an object through a chain of calls, with no command object:

```ts
await storage.bucket("reports-prod").file(`reports/${id}.pdf`).download();
```

The operation at the end tells whether the call reads or writes, and the chain before it gives the bucket and the object. The pack checks where the operation is declared, so it only counts the library's own operations and ignores a `download` on something the project wrote. When a step was stored in a variable first, the pack follows it back to where it was built. That covers a repository class that keeps one bucket and asks it for a file on each call.

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

`getSignedUrl` gives the caller a URL that reaches the object later, so the pack counts it as an access now. Whether it reads or writes depends on the action the caller signed for:

```ts
.getSignedUrl({ version: "v4", action: "write", expires })   // a write
.getSignedUrl({ version: "v4", action: "read", expires })    // a read
```

A request with no action counts as a read, since that is how the library treats it.

## A bucket the call site does not know

A storage layer usually takes the bucket and the path as arguments:

```ts
const object = {
  getContent: (location: StorageObjectLocation) =>
    storage.bucket(location.bucket).file(location.path).download(),
};
```

Nothing there shows which bucket, so the container comes out null and the access is still recorded. The bucket depends on the callers, and pairing a wrapper's callers with the store it reaches is still open work.

## Where it fits in suss

The pack depends on `@suss/behavioral-ir` for the binding it builds, and on `@suss/adapter-typescript` for the declaration check and for reading a name. The storage pass in `@suss/checker` pairs what this pack records with whatever declares the bucket.
