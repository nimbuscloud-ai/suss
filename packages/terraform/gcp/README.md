# @suss/terraform-gcp

Says what Google Cloud's Terraform provider declares, for `@suss/contract-terraform` to read, and judges one pair of resources the provider only refuses at apply time.

## What this package is

A pack. Two entries say what a resource is, and one rule says when two of them disagree.

```ts
import { terraformFileToSummaries } from "@suss/contract-terraform";
import { checkAlertConditions, googleTerraform } from "@suss/terraform-gcp";

const summaries = terraformFileToSummaries("infra/terraform/monitoring", {
  packs: [googleTerraform()],
});
const findings = checkAlertConditions(summaries);
```

`suss contract --from terraform <path>` loads the entries for you. The rule runs from here, since `suss check` reads summaries off disk and loads no packs.

## What it reads today

| Resource | Becomes |
| --- | --- |
| `google_logging_metric` | a metric, identified by the type Cloud Monitoring gives it, `logging.googleapis.com/user/<name>` |
| `google_monitoring_alert_policy` | one consumer of a metric per `condition_threshold`, identified by the `metric.type` its filter states |

Everything else a configuration declares is skipped.

## The pair the provider refuses

A log-based metric can declare that each measurement is a spread of buckets:

```hcl
resource "google_logging_metric" "sweep_refused" {
  name = "sweep-refused"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
  }
}
```

An alert policy refers to it through a filter string, and compares it to a number:

```hcl
condition_threshold {
  filter          = "metric.type=\"logging.googleapis.com/user/sweep-refused\" AND resource.type=\"cloud_run_revision\""
  comparison      = "COMPARISON_GT"
  threshold_value = 5
}
```

Both blocks are well formed, `terraform validate` and `terraform plan` both pass, and the apply fails minutes in: a distribution has no single value to compare, and Cloud Monitoring wants an aligner such as `ALIGN_PERCENTILE_95` to reduce each window to one number first. `checkAlertConditions` reports that pair as a `boundaryShapeMismatch` at error severity, which is the finding kind for two sides that disagree about a value's type. One side says the measurements are a spread; the other treats them as a number.

A condition that states one of the percentile aligners under `aggregations` is left alone, as is a condition on a metric declared as `INT64` or `DOUBLE`.

## What it will not tell you

- **A condition about a metric nothing in the run declares** says nothing. Most alerts watch metrics the platform publishes, and a metric declared in a module this run did not read looks the same from here. The pairing pass reports a boundary with one side missing.
- **A condition that states no `metric.type`** leaves the condition with no metric type on it, so it pairs with nothing rather than pairing with the wrong thing. An SLO burn-rate condition is written as a call rather than a comparison, and it is about an objective rather than a metric, so it lands here.
- **A metric the platform publishes**, `run.googleapis.com/request_latencies` and everything like it, states its value type in Google's documentation rather than in any configuration. Judging a condition on one of those needs a catalog this does not ship.
- **`for_each` and `count`** state one block for many resources, and the reader takes the block as written.

## How the identity is built

Cloud Monitoring puts every metric a project defines for itself under `logging.googleapis.com/user/`, and the alert spells that whole string, so the whole string is the identity the two sides share. A name built at deploy time keeps its hole: `name = "${var.environment}-refusals"` becomes `logging.googleapis.com/user/{var.environment}-refusals`, and a filter that interpolates the same variable is spelled the same way.

## Where it fits in suss

Depends on `@suss/contract-terraform` for the shape of an entry and for the filter reader, and on `@suss/behavioral-ir` for the summaries the rule walks. The reader knows nothing about Google: it reads the attribute paths these entries ask for and pairs the two sides on the metric type, and what those attribute values mean is in `src/alertConditions.ts`.
