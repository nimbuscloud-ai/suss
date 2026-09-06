class ApplicationController < ActionController::Base
  before_action :require_login

  rescue_from ActiveRecord::RecordNotFound, with: :not_found

  private

  def require_login
    head :unauthorized if session[:user_id].nil?
  end

  def not_found(error)
    render json: { error: error.message }, status: :not_found
  end
end
