def build_pool(settings)
  ActiveRecord::Base.connection.exec_query("SELECT id FROM dim_account LIMIT 1")
  settings
end

def run_report
  ActiveRecord::Base.connection.execute("SELECT count(*) FROM dim_account")
end

def sync_accounts(pool)
  ActiveRecord::Base.connection.exec_query("UPDATE dim_account SET synced_at = now()")
  pool
end

def close_pool(pool)
  ActiveRecord::Base.connection.execute("UPDATE dim_account SET closed_at = now()")
  pool
end
