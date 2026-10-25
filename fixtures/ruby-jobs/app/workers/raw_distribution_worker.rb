class RawDistributionWorker
  include Sidekiq::Worker

  sidekiq_options queue: :push

  def perform(export_id)
    AsyncFileExport.find(export_id)
    targets
  end

  def self.enqueue_for(export)
    perform_async(export.id)
  end

  protected

  def targets
    []
  end
end
