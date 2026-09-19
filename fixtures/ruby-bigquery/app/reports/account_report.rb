require "google/cloud/bigquery"

# The table this report reads, reached through the module that declares it.
ACCOUNTS_TABLE = Tables::ACCOUNTS

class AccountReport
  def initialize
    @bigquery = Google::Cloud::Bigquery.new(project_id: ENV["GCP_PROJECT"])
  end

  def tier_rollup(tier)
    @bigquery.query(
      "SELECT id, name FROM `#{ACCOUNTS_TABLE}` WHERE tier = @tier",
      params: { tier: tier }
    )
  end

  def recent_events(since)
    dataset = @bigquery.dataset("core")
    dataset.query("SELECT id, kind FROM events WHERE occurred_at > @since", params: { since: since })
  end

  def record_run(rows)
    @bigquery.dataset("core").table("report_runs").insert(rows)
  end

  def drop_scratch
    @bigquery.dataset("core").table("scratch").delete
  end

  def start_rollup
    @bigquery.query_job("SELECT id FROM `analytics-prod.core.dim_account`")
  end

  def whatever(sql)
    @bigquery.query(sql)
  end
end
