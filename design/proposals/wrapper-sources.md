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
`functionValueOf` asks the store for a callable, and the store gives a
call no `comesTo` result on purpose. So the registration is dropped,
and nothing records that it was. `defaultHook` is a wrapper handed to
the constructor, and a pack can only declare a wrapper as a method
called on the app.

The third problem is the reporting. Once a middleware composes, a
status it returns that no contract declares becomes one finding per
route it wraps: seventeen findings for one line of code.

## A wrapper returned by a factory

A pack does not need to declare anything new. The store already derives
what a call gives back:

```
givesBack(x, z) :- reaches(x, z, result), func(z).
```

`requireCaller` returns an arrow function, so `givesBack` on the
`app.use` argument is that arrow. The wrapper index asks a new store
question, `resolveReturnedCallable(call)`, which is read off
`givesBack` under the same single-answer policy as `resolveCallable`.
When the rules reach two different functions from a factory's return,
the question returns nothing. `functionValueOf` tries the returned
callable only when the argument is a call, so a name still resolves the
way it does now.

The returned arrow has no name, and the summary key is file plus name.
The reference uses the factory's name, `requireCaller`, because a reader
asking why a route returns 401 wants to see that name. The unit the
index creates for the arrow gets the same name. Two registrations
calling the same factory with different arguments land on one arrow
node and one summary, and that is correct. The body is the same, and
the walk does not read what the arguments change.

The `comesTo` contract in `adapter-fact-contract.md` does not change. A
call still has no `comesTo`. The new question is a separate one, and
the unwrapping result stays where it is.

A registration whose argument is a call the store cannot follow gets a
gap on the route, `unfollowedCall`, the way a refused receiver does.
Today it gets nothing, and that is why the motivating service is
reported as unwrapped instead of partly read.

## A wrapper handed to the constructor

`defaultHook` runs when a request fails the route's request schema, and
it responds in the handler's place. It never passes the request on, so
as a composed wrapper it has only short circuits. `applyWrapper`
already reports a wrapper with no `delegate` beside the route's own
outcomes. That is the right result for a validation hook: a 400 the
handler body never shows, under a condition the body never tests.

What is missing is discovery. `wraps` gains one form:

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
hook referred to by name and a hook from a factory are all read the
same way.

The hook's conditions differ from the route's request schema. To state
"when the body fails `CreateTenantSchema`", the route's declared input
has to be joined to the wrapper's transition, and nothing composes
conditions from two summaries today. Step 2 below reports the 400 with
the hook's own conditions, and the composed transition records which
hook it came from. Joining the schema in comes later, and the count on
the motivating service does not need it.

## The contract compared against the wrappers

`checkContractAgreement` only compares declared contracts across
sources and never reads a handler's transitions, so a wrapper's status
does not turn into noise there. The noise comes from `detectGaps`,
which compares a route's declared responses against its own body at
assembly, before `composeWrappers` runs. Every status a wrapper
produces is reported as declared but never produced, once per route
the wrapper covers. A consumer pairing with the route then turns each
of those gaps into a `providerContractViolation`.

Proposal: run the same comparison again over the composed transitions
and replace the assembly-time gaps. A status a wrapper produces counts
as produced. A status the contract leaves out is reported against the
wrapper by name, since the transition that produced it records
`wrappers.from`. An error handler's responses count as produced on
every route it covers, whether or not a throw was in view, because
anything the route calls can throw at runtime.

Each route keeps its own gap. Collapsing the gaps a wrapper produces
across routes into one finding against the wrapper's summary would need
a wrapper pointer on the gap and a grouping pass in the checker. The
per-route gap already records which wrapper produced the status, so
the proposal leaves collapsing out.

## Acceptance

`fixtures/wrapped-routes` gains a factory-built middleware and a
`defaultHook`, and the acceptance journey asserts:

- `POST /v1/tenants` reports 401 from `requireCaller` when the
  middleware is `requireCaller(config)`.
- Every route on the app reports 400 from `validationHook`.
- A route that declares 400, 401 and 500 gets no gap for them once the
  hook, the middleware and the error handler compose in, and a
  middleware returning 429 that no contract declares gets a gap on the
  route that says which middleware produced it.
- `app.use(pickMiddleware())`, where `pickMiddleware` is a declaration
  with no body, produces an `unfollowedCall` gap on each route and no
  wrapper.

Then re-run the motivating service at the same pin. It has 85 warnings
before. The number after is the count of true disagreements on that
service, and the before-and-after in the PR states it.

## Cost

The returned-callable question runs once per registration whose
argument is a call, over facts the store already has. The constructor
option is one more pattern in the wrapper index's per-file scan. The
second contract comparison runs once per composed unit over transitions
composition already built. None of the three adds a pass.

## Order

1. The factory-returned wrapper, with the `unfollowedCall` gap when the
   call does not resolve. This alone moves the count on the motivating
   service: the 401 and 403 are two of the five statuses behind the 85,
   and the 500 and 503 from `onError` already compose wherever a
   handler throws in view of the walk.
2. The constructor option.
3. The contract comparison run again after composition.

Each step ships with its own before-and-after on the fixture and on the
motivating service.
