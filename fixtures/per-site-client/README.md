# per-site-client

Two client classes whose values can only be settled once you know which
construction site created the instance. `per-site-client-python` and
`per-site-client-ruby` have the same two cases in the other two
languages, and `packages/cli` extracts all three in one test.

The catalog client receives its base path when it is created. One
method builds every URL from that base and the endpoint it was given.
Ten methods call it with a literal endpoint, and two modules construct
the class with different bases. Reading the URL-building method once
per construction site settles the base. The endpoint does not depend on
the site, so suss asks about it once, not once per site. Asking once per
site is what made 0.31.0 spend most of a run on one small package.

The reports client receives an API key when it is created, inside a
factory that awaits a config call first. For this case, the question
per site used to walk without ever settling, and the row budget in
`@suss/datalog` now stops it.

Nothing here is installed or run. The source calls `axios`, `requests`
and `faraday` so the client packs recognize the calls, and the test
lists the paths a run should return.
