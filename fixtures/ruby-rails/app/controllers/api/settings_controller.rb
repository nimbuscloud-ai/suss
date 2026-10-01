module Api
  # The filter raises a gem's exception and `update` raises the project's
  # own. Each reaches the handler registered for its class, and no other.
  class SettingsController < BaseController
    before_action :forbid_token_users

    def show
      render json: {}
    end

    def update
      raise Billing::LimitReached, "plan limit" if params[:count].to_i > 10
      render json: {}
    end

    private

    def forbid_token_users
      return unless params[:token]

      raise Gatekeeper::AccessDenied.new("token users may not do this")
    end
  end
end
