# ruby-concern-env

A plain Ruby project with a Sidekiq job and no Rails. The job includes
an ActiveSupport concern that reads the environment in three places: an
assignment in its `included` block, an instance method defined inside
that block, and a class method defined in its `class_methods` block. The
run lists only the sidekiq pack, so every read here has to be found
without the rails pack.
