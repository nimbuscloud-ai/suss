# Rails autoloads app/controllers/concerns as a directory of its own, so
# this module is `Audited` and not `Concerns::Audited`.
module Audited
  extend ActiveSupport::Concern

  included do
    before_action :require_audit_token
  end

  private

  def require_audit_token
    head :forbidden if request.headers["X-Audit-Token"].blank?
  end

  def record_audit
    Account.find(params[:account_id]).lapse!
  end
end
