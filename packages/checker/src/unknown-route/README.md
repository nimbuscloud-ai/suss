# unknown-route/

This directory reports a REST call to a path its own service does not serve, as `restMethodOnUnknownPath`. It runs after pairing and reads the consumers pairing left unpaired. Pairing itself does not change, so `ask` and every other pass see the same pairs.

## Why each condition is there

Most unpaired calls are not missing routes. On a public Next.js app, a check leaves about 85 calls unpaired, and nearly all of them go to other companies' APIs. The few that go to the app's own `/api` are calls suss read only in part, and the route exists for each one. So a call is reported only when suss read enough, on both sides, to say the route is not there.

- **The service.** A relative URL goes to the workspace whose code makes the call. A base URL the deployment sets goes to the one service with routes under the path the base gives, and two or none leave it unsettled. A host the code writes out is left alone: a public host is another company's API, and a host that can be the project's own, such as `localhost:4000` or a container's name, may be any of the run's services. A call whose service stays unsettled goes under `unchecked.routes` with the reason.
- **The call.** The method is known, and every segment of the path is text or a whole-segment parameter. A segment that mixes a hole with text, a set of texts, a range hole, an open base URL, or a URL with a part from a value suss could not read (`urlPartUnread` on the client's http metadata) may be a path the service serves. That part is a fallback's default taken over the value, as in `${process.env.API_URL ?? ""}/teams`, or a base URL the client was built on that suss left out of the path, as with `axios.create({ baseURL: process.env.API_URL })`. A helper whose method or host comes from its caller (`bindingFrom`) has its library's defaults in its binding, so it is left out too.
- **The route table.** Every route in the service has a method and a path, none takes every path (`isCatchAll`), and every route has its pack's served-beside statement. The adapters write it on each route a pack recognized, as `metadata.servedBeside`, listing what else serves requests: pages, static files, rewrites, redirects, middleware matchers, proxies and mounts, each as a route path or a regular expression, or with neither when the pack could not read which paths it covers. A route the routing declares whose controller suss did not recognize, such as a Rails controller built on `ActionController::Metal`, leaves no summary, so the Ruby adapter lists its path as unread too. A route with no statement makes its service ineligible, since "no route matches" could mean "suss did not read what does".
- **The routes.** A route that meets the call under its method, whatever the call's holes are, may serve it, as `/teams/{id}/invites` may serve `/teams/{id}/{kind}`. Pairing does not pair those, because it never guesses that a hole equals a written segment, and this pass does not report them either.

## Key files

- `unknownRoute.ts:checkUnknownRoutes` is the pass. `checkAll` calls it with the production summaries and the unpaired consumers.
- `servedBeside.ts:servesCall` says whether one served-beside entry covers a call. A regular expression is tried with each hole in the call filled by every word the expression spells, so a hole that could be `api` meets a matcher that leaves `api/` out.

## Gotchas

- **The provider side repeats the consumer.** There is no route to point at, and a finding has to name a provider. `target` on the finding gives the service, its route count and the routes nearby.
- **A Ruby run labels no workspace.** Every Ruby summary is in the unnamed service, and a TypeScript client always has a workspace, so a relative call from a frontend in the same repository never reaches the Rails routes. A base URL the deployment sets can.
