# The script a scheduler runs, which makes every call above. The verb
# `relay` passes on comes from the command line.

require_relative "../app/grants"

grants = Grants.new
grants.list
grants.create("{}")
grants.revoke("g1")
grants.relay("g1", ARGV.first)
grants.renew("g1")
grants.audit
