# The script a scheduler runs, which makes every call above.

require_relative "../app/grants"

grants = Grants.new
grants.list
grants.create("{}")
grants.revoke("g1")
grants.renew("g1")
grants.audit
grants.purge("g1")
