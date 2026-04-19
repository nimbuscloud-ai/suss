# Get started

Fifteen minutes, one concrete project. By the end you'll have
extracted behavioral summaries from both a provider and a
consumer, paired them, and seen your first finding.

This is the **tutorial** — hand-holding, end-to-end. For task
recipes ("add suss to CI", "suppress a finding"), see the
[how-to guides](/guides/add-to-project). For conceptual
background ("why does suss exist"), see [Motivation](/motivation).

## What we'll build

A small ts-rest API with a known contract mismatch between the
handler and the client. Each side lives in its own source file;
suss notices that the handler can return a status the client
doesn't handle, and reports it.

## Step 1. Set up a workspace

```bash
mkdir suss-tutorial && cd suss-tutorial
npm init -y
npm install --save-dev \
  typescript \
  @suss/cli \
  @suss/framework-ts-rest \
  @suss/runtime-axios \
  @ts-rest/core @ts-rest/express express axios zod
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

## Step 2. Write the provider

`src/handler.ts`:

```ts
import { initContract, initServer } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

export const contract = c.router({
  getUser: {
    method: "GET",
    path: "/users/:id",
    responses: {
      200: c.type<{ id: string; name: string }>(),
      404: c.type<{ error: string }>(),
    },
  },
});

const s = initServer();

export const router = s.router(contract, {
  getUser: async ({ params }) => {
    if (!params.id) {
      return { status: 404, body: { error: "id required" } };
    }
    const user = await findUser(params.id);
    if (!user) {
      return { status: 404, body: { error: "not found" } };
    }
    // Contract says 500 isn't declared; the handler never
    // produces it. But watch what happens when we add one —
    // we'll revisit in step 5.
    return { status: 200, body: user };
  },
});

declare function findUser(id: string): Promise<{ id: string; name: string } | null>;
```

## Step 3. Write the consumer

`src/client.ts`:

```ts
import axios from "axios";

export async function loadUser(id: string) {
  const res = await axios.get<{ id: string; name: string }>(`/users/${id}`);
  if (res.status === 200) {
    return res.data;
  }
  // The consumer only handles 200. It has no branch for 404.
  // That's the mismatch we'll see in step 4.
  throw new Error("unexpected status");
}
```

## Step 4. Extract and check

Extract summaries from both sides:

```bash
npx suss extract -p tsconfig.json -f ts-rest -o summaries/provider.json
npx suss extract -p tsconfig.json -f axios -o summaries/consumer.json
```

Each produces a JSON file with one or more `BehavioralSummary`
objects. Have a look:

```bash
npx suss inspect summaries/provider.json
```

You'll see something like:

```
GET /users/:id
  ts-rest handler | handler.ts:15
  Contract: 200, 404

    -> 404 { error }  when  !params.id
    -> 404 { error }  when  params.id && !findUser()
    -> 200 { id, name }  (default)
```

Now pair them:

```bash
npx suss check summaries/provider.json summaries/consumer.json
```

Expected output:

```
[WARNING] unhandledProviderCase
  Provider produces status 404 but no consumer branch handles it
  provider: src/handler.ts::getUser @ ... (src/handler.ts:15)
  consumer: src/client.ts::loadUser (src/client.ts:3)
  boundary: ts-rest (http) GET /users/:id
```

suss read both files, matched them on `(GET, /users/:id)`, and
noticed the consumer's branches don't cover all provider
outcomes.

## Step 5. Introduce drift

Edit `src/handler.ts` to add a new status code:

```ts
// inside getUser, after the not-found check:
if (user.deletedAt) {
  return { status: 410, body: { error: "gone" } };
}
```

Re-extract and re-check:

```bash
npx suss extract -p tsconfig.json -f ts-rest -o summaries/provider.json
npx suss check summaries/provider.json summaries/consumer.json
```

Now you see two findings — the original 404 miss, plus a new one
for 410. Also, because 410 isn't in the contract:

```
[ERROR] providerContractViolation
  Handler produces status 410 which is not declared in the ts-rest contract
```

Three facts, surfaced automatically:

1. The handler declares behavior the contract doesn't promise
   (contract drift).
2. The handler declares behavior the client doesn't handle
   (consumer gap).
3. The client handles fewer cases than the contract promises
   (client gap — this one fires earlier if you check the
   client against the contract; try it with `suss check --dir`).

## What you just did

- **Extracted** behavioral summaries from provider and consumer.
- **Paired** them by `(method, path)` with `suss check`.
- **Detected drift** without writing any tests — the mismatch
  fell out of the summaries' shapes.

## Where to go next

- **More tasks.** [Add suss to a project](/guides/add-to-project)
  walks the real-world integration; [Set up CI](/guides/ci-integration)
  makes this run on every PR.
- **Understand the output.** The [Findings catalog](/reference/findings)
  enumerates every finding kind with an example.
- **Understand the shape.** [Behavioral summary format](/behavioral-summary-format)
  is the serialization spec; [IR reference](/ir-reference) is the
  type-level reference.
- **Understand the model.** [Three kinds of truth](/contracts)
  grounds the framing that makes these findings meaningful.
