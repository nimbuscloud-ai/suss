class CleanupWorker
  include ::Sidekiq::Job

  sidekiq_options retry: 0

  def perform
    AsyncFileExport.where(status: "done").first
  end
end
