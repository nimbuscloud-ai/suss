# @suss/framework-activejob

The pack for [ActiveJob](https://guides.rubyonrails.org/active_job_basics.html)
and the mailers [ActionMailer](https://guides.rubyonrails.org/action_mailer_basics.html)
sends through it. A request that enqueues a job does none of the job's
work itself, so without this pack the tables a job reads look unread and
nothing the job does shows up anywhere. Run it next to `rails`:

```bash
suss extract --lang ruby -f rails -f activerecord=suss.activerecord.json -f activejob -o .suss/ruby.json
```

```ruby
# app/graphql/mutations/report_export_create.rb
export = AsyncFileExport.create!(...)
ReportExportJob.perform_later(export.id)

# app/jobs/report_export_job.rb
class ReportExportJob < ApplicationJob
  queue_as :exports

  def perform(async_file_export_id)
    export = AsyncFileExport.find(async_file_export_id)
  end
end
```

`ReportExportJob#perform` becomes a `consumer` unit bound to the
`activejob` channel `exports#ReportExportJob`, and its read of
`AsyncFileExport` belongs to it. The `perform_later` becomes a
`message-send` to `ReportExportJob`, with the arguments the job is
given. `suss check` pairs the two, and `suss ask "what does <route>
reach"` follows the send into the job and says the job runs later.

## What it reads

- Job classes: a class whose ancestry reaches `ActiveJob::Base` or
  `ApplicationJob`. Its `perform` is the unit, including a `perform` it
  inherits from a base job. The queue comes from `queue_as` in the
  class's own body, written as a symbol or a string.
- Enqueues: `Job.perform_later(...)`, `Job.set(...).perform_later(...)`,
  `Job.perform_now(...)`, and a bare `perform_later` in one of the job's
  own class methods. `perform_now` runs the job in the caller's process
  right away, and is recorded the same way so its work shows up for the
  caller.
- Mailers: a class whose ancestry reaches `ActionMailer::Base` or
  `ApplicationMailer`. Each public instance method it defines is a
  unit on the channel `UserMailer.welcome`.
- Deliveries: `UserMailer.welcome(user).deliver_later` and
  `deliver_later!`, also with `.with(params)` in front of the message.

## What this leaves out

- An enqueue whose job the run cannot settle, such as
  `job_class.perform_later` or a message picked with `public_send`, is
  recorded with no channel, and the summary gets an `unfollowedCall`
  gap that says so.
- `perform_all_later` and `deliver_now`.
- A job that inherits `perform` is read the way its base job wrote it,
  so when the subclass overrides a method that `perform` calls, the
  summary still follows the base class's version.
- A queue a base class declares, or one `queue_as` works out in a
  block. The job's channel then has no queue, and it pairs with an
  enqueue on any queue.
- A job no code enqueues is never reported as having no producer. A
  scheduler such as Solid Queue's `recurring.yml` can enqueue a job by
  name from a config file this pack does not read.
