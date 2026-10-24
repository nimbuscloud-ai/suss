class UserMailer < ApplicationMailer
  def initialize
    super
  end

  def export_ready(export)
    @export = AsyncFileExport.find(export.id)
    mail(to: params[:user].email)
  end

  private

  def helper_thing; end
end
