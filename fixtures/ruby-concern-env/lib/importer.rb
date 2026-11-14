require "sidekiq"
require_relative "throttled"

class ImportJob
  include Sidekiq::Job
  include Throttled

  class << self
    attr_accessor :throttle_limit
  end

  def perform(batch)
    [batch, throttle_key, self.class.throttle_window, ImportJob.throttle_window]
  end
end
