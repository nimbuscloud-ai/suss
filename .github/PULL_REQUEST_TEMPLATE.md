<!--
Title: the squash commit uses it as its subject. Conventional prefix,
imperative, and the symptom or the change in plain words. No taglines.
-->

## Summary

<!-- One or two sentences: what changed and why. -->

## What changed

<!-- The concrete changes as a short list, grouped by area when it
spans several. -->

## Risk and what to check

**Overall risk: 🟢 Safe** (legend: 🔴 Critical, 🟡 Caution, 🟢 Safe)

<!--
The overall level is the highest item below. Tag each item so a
reviewer sees where to look:
  🔴 Critical: can break production or cause data, money, or security
     harm if wrong (a migration, auth, a shared contract or generated
     schema, a deploy-ordering hazard).
  🟡 Caution: a behavior change or a shared surface, but bounded.
  🟢 Safe: isolated, small blast radius.
Add a line when the change adds a feature flag, a schema change, or
new infrastructure, since a reviewer cannot always see that in the
diff. When everything is isolated, "Overall risk: 🟢 Safe (isolated)"
is enough.
-->

## Context the code does not show

<!-- The reason for the approach, the constraints, and any decision a
reader would not expect, a sentence or two each. Leave this out when
the diff explains itself. -->

## Test plan

<!-- How you verified it. -->

## Related issues

<!-- "Closes #123", "Refs #456", or "n/a". -->
