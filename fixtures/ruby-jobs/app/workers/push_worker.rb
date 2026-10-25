class PushWorker
  include Sidekiq::Worker

  sidekiq_options queue: "push", retry: 3

  def perform(export_id, event)
    AsyncFileExport.where(id: export_id).first
  end
end
