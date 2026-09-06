# Proposal: the wrappers a route does not register by name

Status: draft, seeking alignment. Nothing here is built.

## Where composition stops today

A route's statuses come from its handler and from the code registered
around it. #734 gave each wrapper a summary of its own, #738 composed
them into the route, and #741 joined a route registered on an `app`
parameter to the wrapper registered on the app the caller passed.
On the service that motivated #726, the count of false
`contractDisagreement` warnings did not move, because neither of its
wrappers gets as far as composition:

```ts
const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
app.use('/v1/*', requireCaller(config, deps.verifier, deps.logger));
```

`requireCaller(...)` is a call, and the wrapper index only takes a
function written out at the registration or referred to by name.
`functionValueOf` asks the store for a callable and the store gives a
call no `comesTo` answer on purpose, so the registration is dropped and
nothing says it was. `defaultHook` is a wrapper handed to the
constructor, and a pack can only declare a wrapper as a method called
on the app.

A third piece is the reporting. Once a middleware composes, a status it
returns that no contract declares becomes one finding per route it
wraps, seventeen findings for one line of code.

## A wrapper returned by a factory

A pack does not need to say anything new. The store already derives
what a call gives back:

```
givesBack(x, z) :- reaches(x, z, result), func(z).
```

`requireCaller` returns an arrow function, so `givesBack` on the
`app.use` argument is that arrow. The wrapper index asks a new store
question, `resolveReturnedCallable(call)`, which is read off
`givesBack` under the same single-answer policy as `resolveCallable`:
a factory whose return the rules reach two different functions from
gives nothing. `functionValueOf` tries the returned callable only when
the argument is a call, so a name still resolves the way it does now.

The returned arrow has no name, and the summary key is file plus name.
The reference takes the factory's name, `requireCaller`, which is what
a reader asking why a route returns 401 wants to see, and the unit the
index creates for the arrow is named the same way. Two registrations
calling the same factory with different arguments land on one arrow
node and one summary, which is right: the body is the same, and what
the arguments change is not something the walk reads.

The `comesTo` contract in `adapter-fact-contract.md` does not change. A
call still has no `comesTo`; the new question is a separate one, and
the unwrapping answer stays where it is.

A registration whose argument is a call the store cannot follow gets a
gap on the route, `unfollowedCall`, the way a refused receiver does.
Today it gets nothing, which is why the motivating service reads as
unwrapped rather than as partly read.

## A wrapper handed to the constructor

`defaultHook` runs when a request fails the route's request schema and
responds in the handler's place. It never continues, so composed as a
wrapper it has only short circuits, and `applyWrapper` already reports
a wrapper with no `delegate` beside the route's own outcomes. That is
the right result for a validation hook: a 400 the handler body never
shows, under a condition the body never tests.

What is missing is discovery. `wraps` grows one form:

```ts
wraps: {
  constructorOption: "defaultHook",
  targetPosition: 0,          // the options object
}
```

The subject is the construction itself, which is already the id every
wrapper and route keys on, so the join costs nothing. The scope is
every route on that app. The target is the option's value, resolved
through `functionValueOf` like any other, so a hook written inline, a
hook by name and a hook from a factory all read the same way.

The hook's conditions are not the route's request schema. Saying "when
the body fails `CreateTenantSchema`" needs the route's declared input
joined to the wrapper's transition, and nothing composes conditions
from two summaries today. Step 2 below reports the 400 with the hook's
own conditions, and the composed transition records which hook it came
from. Joining the schema in is a later step and not needed for the
count on the motivating service.

## One finding per wrapper

`checkContractAgreement` compares the status sets of every source on a
boundary and reports each status one source declares and another does
not. A handler's derived contract now includes what its wrappers
return, so a middleware returning a status no contract declares is
reported once per route.

Proposal: keep provenance on the derived contract. `readDeclaredContract`
takes a handler's statuses from its transitions, and a transition a
wrapper contributed has `wrappers.from` on it. The derived contract
keeps that on each response. `compareSources` then splits its disagreements:
a status every disagreeing route got from the same wrapper reference is
collected across boundaries and reported once, against the wrapper's
file and name, with the routes it reaches listed in the description. A
status a handler produced itself is reported against the route as now.

The finding kind stays `contractDisagreement`. What changes is which
summary the `provider` side points at and how many findings there are.
The docs note for the kind says a finding can now point at a wrapper.

## Acceptance

`fixtures/wrapped-routes` gains a factory-built middleware and a
`defaultHook`, and the acceptance journey asserts:

- `POST /v1/tenants` reports 401 from `requireCaller` when the
  middleware is `requireCaller(config)`.
- Every route on the app reports 400 from `validationHook`.
- A middleware returning 429, declared by no contract, produces one
  finding naming the middleware and listing three routes.
- `app.use(pickMiddleware())`, where `pickMiddleware` is a declaration
  with no body, produces an `unfollowedCall` gap on each route and no
  wrapper.

Then the motivating service, re-run at the same pin: 85 warnings before,
and the number after is the count of true disagreements on that
service, which the before-and-after in the PR states.

## Cost

The returned-callable question runs once per registration whose
argument is a call, over facts the store already has. The constructor
option is one more pattern in the wrapper index's per-file scan. The
checker change groups findings it already produces. None of the three
adds a pass.

## Order

1. The factory-returned wrapper, with the `unfollowedCall` gap when the
   call does not resolve. This alone moves the count on the motivating
   service: the 401 and 403 are two of the five statuses behind the 85,
   and the 500 and 503 from `onError` already compose wherever a
   handler throws in view of the walk.
2. The constructor option.
3. One finding per wrapper.

Each step ships with its own before-and-after on the fixture and on the
motivating service.
