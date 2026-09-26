---
name: intent
description: Write the change list for a request before the first edit, the behavior changes you intend in the words suss uses, so that suss can check the work against it when you stop. Use it after the developer asks for something that will change code, when the suss hook asks for a change list, and when the developer runs /suss:intent to see the current one.
---

# The change list

Before your first edit for a request that will change code, write down the behavior changes you intend, one per entry, and print the list for the developer. When you stop, suss compares what the code now does with the list. It says which entries are done, which are not, and which changes nobody asked for.

## Where it goes

`.suss/session/${CLAUDE_SESSION_ID}/intent.yaml` under the project directory. The suss hook gives the full path along with the request. When you do not have the session id, `.suss/session/current.json` says which session the suss hooks last saw. Write it with the Write tool. suss does not read the project again after an edit to this file.

## What goes in it

```yaml
asked: "Add POST /orders/:id/cancel. Cancelling sets cancelled_at ... 404 when the order does not exist."
changes:
  - adds: POST /orders/:id/cancel
    outcomes: [200, 404]
  - adds: { writes: postgresql:orders, fields: [cancelled_at] }
    at: POST /orders/:id/cancel
  - changes: Order.status
    note: gains the value "cancelled"
```

- `asked` quotes the developer's message. Copy the words from it, and write `...` for a stretch you leave out. suss checks the quote against the messages the developer sent. An entry whose quote is in none of them is shown to the developer as declared without a request.
- Each entry has one verb: `adds`, `removes` or `changes`.
- The subject is a boundary, spelled the way `suss ask` and suss's reports spell it: `POST /orders/:id/cancel`, `postgresql:orders`, `aws.sqs:jobs`. Or it is an effect, written like a `results` line of an intent document: `reads`, `writes` or `invokes`, then the boundary, with `fields` and `by` when you know them.
- `outcomes` lists what a boundary should end with: statuses such as `404`, or `returns`, `throws`, `{ throws: NotFoundError }`.
- `at` says which boundary an effect happens at. Leave it out when the effect should happen wherever the code runs it, as with a helper many routes call.
- `note` says in words what the change is, for a subject suss has no spelling for, such as a new member of a type. suss reports that entry as unchecked, and it never blocks a stop.

Follow these when you write it:

- One change per entry.
- Do not predict conditions. Say what the boundary should do, not which branch leads there. There is no `when`.
- When you are not sure how suss spells a boundary, ask. The `suss_boundaries` tool lists them, and `suss ask "what does <file> reach"` lists what a file touches. A spelling suss does not use makes the entry not done, or unchecked.
- Print the list for the developer once it is written, so they can correct it before you edit. When they correct it ("409 on a duplicate, not 400"), rewrite that entry.
- When the developer asks for more in the middle of the task, add an entry with its own `asked:` that quotes that message.

## When you stop

The Stop hook checks the list against the code, and blocks your stop once for each of these:

- An entry that is not done. Finish it, or take it out of the list if the developer no longer wants it.
- A boundary that changed where no entry asked for it. Revert the change, or keep it and add a line under `explained:` that says why:

```yaml
explained:
  - changes: POST /orders
    outcomes: [409]
    why: a second open order for the same sku was charged twice, so POST /orders refuses it
```

An `explained` line takes the same verb, subject, `outcomes` and `at` as an entry, plus `why`. The developer reads the reason in the report, and the next stop passes.

Once a stop passes, suss files the list away, and the next request starts with none.

## When the developer runs /suss:intent

Print the current change list exactly as it is on disk, in a yaml code block. If this request has none yet, say so.
