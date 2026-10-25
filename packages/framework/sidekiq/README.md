# @suss/framework-sidekiq

The pack for [Sidekiq](https://github.com/sidekiq/sidekiq) jobs. A
request that enqueues a job does none of the job's work itself, so
without this pack the tables a job reads look unread and nothing the job
does shows up anywhere. Run it next to `rails`:

```bash
suss extract --lang ruby -f rails -f activerecord=suss.activerecord.json -f sidekiq -o .suss/ruby.json
```

```ruby
class PushWorker
  include Sidekiq::Worker
  sidekiq_options queue: "push", retry: 3

  def perform(status_id)
    Status.find(status_id)
  end
end

PushWorker.perform_async(status.id)
```

`PushWorker#perform` becomes a `consumer` unit bound to the `sidekiq`
channel `push#PushWorker`, and its read of `Status` belongs to it. The
`perform_async` becomes a `message-send` to `PushWorker`, with the
arguments the job is given. `suss check` pairs the two, and `suss ask
"what does <route> reach"` follows the send into the job and says the
job runs later.

## What it reads

- Job classes: a class that includes `Sidekiq::Job` or `Sidekiq::Worker`,
  itself or through a base class. Its `perform` is the unit, including a
  `perform` it inherits from a base job. The queue comes from
  `sidekiq_options queue:` in the class's own body.
- Enqueues: `Job.perform_async(...)`, `Job.perform_in(delay, ...)` and
  `Job.perform_at(time, ...)`, also with `Job.set(...)` in front, and a
  bare one in one of the job's own class methods.

## What this leaves out

- An enqueue whose job the run cannot settle, such as
  `worker_class.perform_async`, is recorded with no channel, and the
  summary gets an `unfollowedCall` gap that says so.
- `perform_bulk`, `perform_inline`, `Sidekiq::Client.push`, and
  `push_bulk` from the sidekiq-bulk gem.
- A job that inherits `perform` is read the way its base job wrote it,
  so when the subclass overrides a method that `perform` calls, the
  summary still follows the base class's version.
- `Sidekiq::IterableJob`, whose worker runs `build_enumerator` and
  `each_iteration` instead of `perform`.
- A job no code enqueues is never reported as having no producer. A
  scheduler such as sidekiq-cron or sidekiq-scheduler can enqueue a job
  by name from `sidekiq.yml`, which this pack does not read.
