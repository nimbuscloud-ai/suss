require_relative "../app/sync"

# Ruby runs an each block before each returns, so the call in it is work
# the file does as it loads.
%w[eu us].each do |region|
  sync_accounts(region)
end

# The library decides when a transaction block runs, so the call in it is
# listed as one the walk did not follow.
ActiveRecord::Base.transaction do
  close_pool(nil)
end
