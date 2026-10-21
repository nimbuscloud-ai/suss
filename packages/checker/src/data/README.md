# data/

This module finds the paths that use the same data and send something out. `suss inspect --diff` uses it to list the other exits of data a change moved, and `suss ask 'what else sends the data <unit> sends'` uses it for one unit.

## What counts as the same data

A datum is one of three things:

- `column`: a column a path reads from a store, keyed by the store's pairing key (`postgresql:players`) and the column.
- `sends`: a field a path puts on a boundary. That is a field of the body a route responds with, or a field of a message a producer publishes.
- `reads`: a field a path takes off a boundary. That is a field a client reads off the response it gets back, or a field a message consumer reads out of the message.

Two paths share a datum only when both use it under the same key: the same column of the same store, or the same field on the same side of the same boundary. A field name alone never matches. A route that sends `golden` and a client of a different route that reads `golden` share nothing.

When suss could not read which columns or fields a read takes, the read uses no datum. A query with no column list (`SELECT *`, `Player.all`, `findMany()` with no `select`) is one. So are a read through a relation path, a client that takes the body whole, and a message consumer whose reads the read-set rule declines to compare. Each becomes an unread entry with the reason, and a caller lists it as not checked. A sibling is reported only when suss read both sides.

## What counts as sending data out

A path sends data out when its output is a response from a provider, a render, an emit, or a return from a provider on a boundary that leaves the process. Its effects count too: a storage write, a message send, a write to a stream, a unit invocation, and a service call with any method other than `GET`, `HEAD` or `OPTIONS`. An effect of a function the path calls counts the same as the path's own.

## The relations

The base facts, one row per thing read off a summary:

| Relation | Meaning |
|---|---|
| `onPath(path, unit)` | A transition belongs to a summary. |
| `unitFunction(unit, fn)` | A summary describes this function, keyed the way `functionOf` keys one. |
| `testUnit(unit)` | The summary is test code. |
| `pathUses(path, datum)` | The transition's own effects or output use the datum. |
| `functionUses(fn, datum)` | Some transition of the function uses the datum. |
| `datumScope(datum, scope)` | The store or boundary side a datum belongs to. |
| `pathUnread(path, scope, reason)` and `functionUnread(fn, scope, reason)` | A read of that store or boundary side suss could not read. |
| `pathExit(path, how)` and `functionExit(fn, how)` | How the transition, or some transition of the function, sends data out. |
| `pathCalls(path, fn)` | The transition calls the function, through an invocation the run resolved. |
| `calls(fn, fn)` | Every derived call edge from `readCallFacts`, which covers written calls, calls bound through an export, wrappers and callbacks. |

A question adds `startPath`, or `asked` and `changed`, and evaluates one rule set over a fresh database loaded with the same base facts.

## The rules

`dataOn` follows `pathCalls` and then `calls` forward from each asked path, and collects `functionUses` and `functionUnread` along the way.

`sharing` works backwards from the asked data, so it only visits functions that lead to it:

- `hasData(fn, datum)` is true of a function that uses the datum or calls one that does. `pathHas(path, datum)` lifts that to a path.
- `mayHave` and `pathMay` do the same for unread reads of the datum's store or boundary side.
- `candidate(path)` is a path from either list. `pathSends(path, how)` follows calls forward from candidates only, to the exits they reach.
- `callsChanged(fn)` is a changed function or anything that calls one. `calledByChanged(fn)` is anything a changed function calls. A unit in either is part of the change and is left out, and so is a test unit.
- `shares(path, datum)` and `mayShare(path, reason)` are the candidates that send data out and are not left out.
- `nested(inner, outer)` drops a listed path that another listed path calls into, so a helper that reads and writes the data is shown once, under the route that calls it.

## What it does not cover

It does not follow a value from a column into a body field, so a route that reads `golden_count` and responds with `golden` is a moved field with no column behind it. `inspect --diff` says so in a note. It does not see a mail send that has no pack, a CSV written by a library suss does not read, or a link to a page inside an email body.
