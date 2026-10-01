module Api
  # Rails tries these handlers last declared first, and runs the first one
  # registered for the raised exception or one of its ancestors.
  class BaseController < ActionController::Base
    rescue_from(Gatekeeper::AccessDenied) { |e| respond_with_denied e }
    rescue_from Billing::LimitReached, with: :respond_with_limit
    rescue_from ActiveRecord::RecordNotFound, with: :respond_with_missing

    private

    def respond_with_denied(error)
      render json: { error: error.message }, status: :forbidden
    end

    def respond_with_limit(error)
      render json: { error: error.message }, status: :payment_required
    end

    def respond_with_missing(error)
      render json: { error: error.message }, status: :not_found
    end
  end
end
