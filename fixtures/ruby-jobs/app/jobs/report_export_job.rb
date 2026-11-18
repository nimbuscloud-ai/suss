class ReportExportJob < ApplicationJob
  queue_as :exports

  def perform(async_file_export_id)
    export = AsyncFileExport.find(async_file_export_id)
    if export.status == "locked"
      self.class.set(wait: 5.minutes).perform_later(async_file_export_id)
      return
    end

    export.update!(status: "done")
  end
end
