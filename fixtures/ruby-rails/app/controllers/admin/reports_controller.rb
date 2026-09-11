class Admin::ReportsController < ApplicationController
  before_action :set_scope
  before_action :set_window

  def index
    OrderService.new.list_orders(current_user)
  end

  private

  # Two filters that hand the request on down either arm, and read a
  # different thing on each. Neither changes what index returns.
  def set_scope
    if params[:team].present?
      @scope = Order.where(team: params[:team])
    else
      @scope = Order.all
    end
  end

  def set_window
    if params[:since].present?
      @window = Order.where("created_at > ?", params[:since])
    else
      @window = Order.recent
    end
  end
end
