require_relative "../../app/sync"

# The library decides whether to run this block, so it is not what the
# file does when it loads.
task :nightly do
  run_report
end
