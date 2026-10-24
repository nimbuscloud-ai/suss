class ExportScheduler
  def self.perform_later(export_id)
    AsyncFileExport.where(id: export_id).first
  end
end
