require "active_support/concern"

# A concern in a project with no Rails around it. ActiveSupport runs the
# `included` block in each class that includes the module, and adds the
# methods of `class_methods` to that class.
module Throttled
  extend ActiveSupport::Concern

  included do
    self.throttle_limit = ENV.fetch("THROTTLE_LIMIT", "10").to_i

    def throttle_key
      ENV["THROTTLE_PREFIX"] || "throttle"
    end
  end

  class_methods do
    def throttle_window
      ENV.fetch("THROTTLE_WINDOW")
    end
  end
end
