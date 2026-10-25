class ExportsController < ApplicationController
  def create
    export = AsyncFileExport.create!(status: "pending")
    ReportExportJob.perform_later(export.id)
    ReportExportJob.set(wait: 5.minutes).perform_later(export.id)
    PushWorker.perform_async(export.id, "created")
    PushWorker.perform_in(30, export.id)
    UserMailer.with(user: current_user).export_ready(export).deliver_later
    job_class.perform_later(export.id)
    head :created
  end

  def update
    export = AsyncFileExport.find(params[:id])
    AccountRawDistributionWorker.perform_async(export.id)
    RawDistributionWorker.enqueue_for(export)
    ExportScheduler.perform_later(export.id)
    head :ok
  end

  def destroy
    export = AsyncFileExport.find(params[:id])
    NoopJob.perform_later(export.id)
    CleanupWorker.perform_async
    mailer_class.export_ready(export).deliver_later
    Notifier.welcome(export).deliver_later
    perform_later(export.id)
    head :no_content
  end
end
