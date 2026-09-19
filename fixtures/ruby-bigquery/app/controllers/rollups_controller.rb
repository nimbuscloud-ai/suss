class RollupsController < ApplicationController
  def index
    render json: AccountReport.new.tier_rollup(params[:tier])
  end
end
