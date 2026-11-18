# ruby-jobs

A Rails app whose two routes enqueue ActiveJob jobs, Sidekiq workers and
an ActionMailer message. One worker inherits `perform` from its base,
one enqueue happens in a worker's own class method, a job and a worker
enqueue themselves again through `self.class`, one goes through a
local nothing settles, and `ExportScheduler.perform_later` is a project
class method on a class that is no job.
