class ReportExportJob < ApplicationJob
  queue_as :exports

  def perform(async_file_export_id)
    export = AsyncFileExport.find(async_file_export_id)
    export.update!(status: "done")
  end
end
