# @suss/framework-aws-s3

Says which S3 buckets a TypeScript service reads and writes, and which objects in them.

## What this package is

A pattern pack. It matches the command a call is handed and reads the command for everything else: which bucket, which key, and whether the call reads or writes.

```ts
import { s3Framework } from "@suss/framework-aws-s3";

const pack = s3Framework();
```

The command class is what it matches on, so it fires wherever the command goes rather than only at `client.send`:

```ts
const command = new GetObjectCommand({ Bucket: bucket, Key: key });
await client.send(command);                          // runs it now
const url = await getSignedUrl(client, command);     // hands back a URL that runs it later
```

Both address the same object, so both read the same. A command is read once however many calls it passes through, since the innermost call that takes it is the one that claims it. A class of the same name from somewhere else is left alone: it fires only when the class comes from `@aws-sdk/client-s3`, including through a project-local module that re-exports the SDK.

## What each command contributes

| Input | What it becomes |
| --- | --- |
| `Bucket` | the container |
| `Key` | the selector, the object the call addressed |
| `Prefix` | the selector for a listing, which is the set of objects it asked for |

A key built from a template becomes a pattern, so `` `uploads/${tenant}/${id}` `` is recorded as `uploads/{tenant}/{id}`. That is the shape a bucket's key convention would be compared against.

An object has no fields the way a row does, so `fields` is always empty. What a call says is the bucket it reached and the key it addressed.

The commands it reads:

- Reads: `GetObject`, `HeadObject`, `ListObjects`, `ListObjectsV2`
- Writes: `PutObject`, `DeleteObject`, `DeleteObjects`, `CopyObject`
- Writes, one object across several calls: `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload`

## The bucket a call reaches

A bucket name is usually built somewhere other than the call site, and the pack follows the same two hops the DynamoDB pack does: a command built into a local resolves back to where it was built, and a field resolves to what the constructor set it to. A value that falls back to a default reads as the default, since that is the bucket the service reaches unless a caller says otherwise.

```ts
this.bucket = process.env.MEDIA_BUCKET ?? "media-prod";  // "media-prod"
this.bucket = `${stage}-media`;                          // "{stage}-media"
```

A name the pack cannot settle comes out null, and null pairs with nothing rather than with whatever spells the same way. A bucket named only by an env var (`Bucket: process.env.MEDIA_BUCKET`, with no default) is one of those: the code says which variable the name comes from rather than the name itself. Grounding a reference like that against the value a deployment sets is open work.

## Where it fits in suss

Depends on `@suss/behavioral-ir` for the binding it builds and `@suss/adapter-typescript` for the import check and for asking what a name was written as. The storage pass in `@suss/checker` pairs what this emits against whatever declares the bucket, which is `@suss/terraform-aws` for an `aws_s3_bucket` resource.
