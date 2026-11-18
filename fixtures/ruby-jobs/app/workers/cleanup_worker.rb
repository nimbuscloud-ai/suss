class CleanupWorker
  include ::Sidekiq::Job

  sidekiq_options retry: 0

  def perform
    export = AsyncFileExport.where(status: "done").first
    self.class.set(queue: "low").perform_async if export.nil?
  end
end
