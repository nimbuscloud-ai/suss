# `Billing::LimitReached` has no file of its own. Loading `Billing`
# defines it, so a lookup finds it here.
module Billing
  class LimitReached < StandardError; end
end
