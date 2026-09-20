require_relative "../app/report_job"
require_relative "../app/sync"

SETTINGS = { "statement_timeout" => ENV["STATEMENT_TIMEOUT"] }

pool = build_pool(SETTINGS)
run_report
ReportJob.new(SETTINGS).run
ReportJob.run_nightly

if __FILE__ == $0
  sync_accounts(pool)
end

# Nothing at module scope calls this, so its statement belongs to no
# summary in this run.
def drop_everything
  ActiveRecord::Base.connection.execute("DELETE FROM dim_account")
end

exit(close_pool(pool))
