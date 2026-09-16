# per-site-client

Two client classes whose values only settle once you know which
construction site made the instance. `per-site-client-python` and
`per-site-client-ruby` are the same two shapes in the other two
languages, and `packages/cli` extracts all three in one test.

The catalog client is given its base path when it is made. One method
builds every URL out of that base and the endpoint it was handed, ten
methods call it with a literal endpoint, and two modules construct the
class with different bases. Reading the building method under each site
settles the base. The endpoint it was handed does not depend on the
site, so it is asked about once rather than once per site; asking per
site is what made 0.31.0 spend most of a run on one small package.

The reports client is given an API key when it is made, inside a factory
that awaits a config call first. That is the shape whose per-site
question walked without ever settling, which is what the row budget in
`@suss/datalog` now stops.

Nothing here is installed or run. The source calls `axios`, `requests`
and `faraday` so the client packs recognize the calls, and the paths a
run should come back with are written out in the test.
