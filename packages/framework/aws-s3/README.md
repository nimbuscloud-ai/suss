# @suss/framework-aws-s3

This pack records which S3 buckets a TypeScript service reads and writes, and which objects in them.

## What this package is

A pattern pack. It matches the command a call is given, and reads everything else from the command: which bucket, which key, and whether the call reads or writes.

```ts
import { s3Framework } from "@suss/framework-aws-s3";

const pack = s3Framework();
```

The pack matches on the command class, so it fires wherever the command goes, including calls other than `client.send`:

```ts
const command = new GetObjectCommand({ Bucket: bucket, Key: key });
await client.send(command);                          // runs it now
const url = await getSignedUrl(client, command);     // hands back a URL that runs it later
```

Both calls address the same object, so both are recorded the same way. A command is read once however many calls it passes through, because the innermost call that takes it claims it. A class with the same name from another module is ignored. The pack fires only when the class comes from `@aws-sdk/client-s3`, including through a module in the project that re-exports the SDK.

## What each command contributes

| Input | What it becomes |
| --- | --- |
| `Bucket` | the container |
| `Key` | the selector, the object the call addressed |
| `Prefix` | the selector for a listing, which is the set of objects it asked for |

A key built from a template becomes a pattern, so `` `uploads/${tenant}/${id}` `` is recorded as `uploads/{tenant}/{id}`. A bucket's key convention would be compared against that pattern.

An object has no fields the way a row does, so `fields` is always empty. A call records the bucket it reached and the key it addressed.

The commands it reads:

- Reads: `GetObject`, `HeadObject`, `ListObjects`, `ListObjectsV2`
- Writes: `PutObject`, `DeleteObject`, `DeleteObjects`, `CopyObject`
- Writes, one object across several calls: `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload`

## The bucket a call reaches

The bucket name is usually built somewhere other than the call site, so the pack follows the same two hops the DynamoDB pack does. A command built into a local variable resolves back to where it was built, and a field resolves to what the constructor set it to. A value with a fallback is recorded as the fallback, since that is the bucket the service reaches unless a caller passes another.

```ts
this.bucket = process.env.MEDIA_BUCKET ?? "media-prod";  // "media-prod"
this.bucket = `${stage}-media`;                          // "{stage}-media"
```

When the pack cannot settle a name, it records null, and null pairs with nothing, even a bucket spelled the same way. A bucket that comes only from an env var (`Bucket: process.env.MEDIA_BUCKET`, with no default) is one of these, because all the code shows is which variable the name comes from. Grounding a reference like that against the value a deployment sets is still open work.

## Where it fits in suss

The pack depends on `@suss/behavioral-ir` for the binding it builds, and on `@suss/adapter-typescript` for the import check and for looking up what a name was written as. The storage pass in `@suss/checker` pairs what this pack records with whatever declares the bucket. For an `aws_s3_bucket` resource, that is `@suss/terraform-aws`.
