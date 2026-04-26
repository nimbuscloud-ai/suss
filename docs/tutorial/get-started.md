# Get started

A small ts-rest API with a known mismatch between handler and
client. Walk through extracting summaries from both sides,
pairing them, and reading the resulting finding.

The handler returns one status the client doesn't handle. suss
catches it from the source alone, without a spec or a runtime trace.

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

### Extract — turn source into structured summaries

```bash
npx suss extract -p tsconfig.json -f ts-rest -o summaries/provider.json
npx suss extract -p tsconfig.json -f axios -o summaries/consumer.json
```

`extract` walks the source pointed at by `tsconfig.json` and runs
the framework pack(s) you name with `-f`. The pack tells suss what
to discover: `ts-rest` finds router handlers and contract
declarations; `axios` finds call sites that send HTTP requests.
The output is a JSON file with one `BehavioralSummary` per
discovered unit — a structured description of every execution path
through that function: which conditions decide which output, what
shape the output has, what effects fire along the way.

This is the canonical artifact. Everything else (`inspect`,
`check`, downstream tooling) consumes this JSON.

Have a look:

```bash
npx suss inspect summaries/provider.json
```

You'll see something like:

```
src/handler.ts
└─ GET /users/:id  (ts-rest handler | line 15)
     Contract: 200, 404
       if  !params.id
         -> 404 { error }
       elif  !findUser()
         -> 404 { error }
       else
         -> 200 { id, name }

1 summaries inspected.
```

The header names the endpoint, the recognition pack, the kind, and
the source line. The decision tree shows every path the handler
can take. The `Contract:` line shows what the ts-rest contract
declares — handy for spotting a gap between declaration and
implementation.

`inspect` is a renderer; nothing here is computed by `inspect`
that isn't already in the JSON. Read [the CLI reference](/reference/cli#suss-inspect)
for the full grammar of the output.

### Check — pair providers with consumers

```bash
npx suss check summaries/provider.json summaries/consumer.json
```

`check` reads two summary files, pairs them by their boundary key
(here, `(GET, /users/:id)`), and runs each pair through agreement
checks: every status the provider produces should have a consumer
branch that handles it; every status the contract declares should
have a producer; body shapes should be structurally compatible.

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
outcomes. The finding names the boundary, both sides, and the
exact disagreement — no global "compliance score", just a
concrete pair-level fact.

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

## What this run exercises

- **Extraction.** Two `suss extract` invocations turned the
  provider's source and the consumer's source into structured
  summaries — JSON for downstream tools, `suss inspect` for a
  human reading.
- **Pairing.** `suss check` paired the two summaries by
  `(method, path)` and ran the cross-boundary checks against
  every transition.
- **Drift detection.** The mismatch fell out of the summaries'
  shapes — no test was written to detect it. The handler's `404`
  branch existed in the source; the client never declared a `404`
  case. The check compared the two and surfaced the gap.

## Further reading

- [Add suss to a project](/guides/add-to-project) — integration in an
  existing repo, including monorepos and per-package tsconfigs.
- [Set up CI](/guides/ci-integration) — `suss check` as a CI gate.
- [Findings catalog](/reference/findings) — every finding kind with an
  example.
- [Behavioral summary format](/behavioral-summary-format) — the
  serialization spec; [IR reference](/ir-reference) is the type-level
  reference.
- [Three kinds of truth](/contracts) — the specification / observation
  / derivation taxonomy that grounds the checker's finding semantics.
