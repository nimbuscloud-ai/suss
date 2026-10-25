class NoopJob < ApplicationJob
  queue_as { :default }
end
