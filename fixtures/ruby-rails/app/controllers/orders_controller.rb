class OrdersController < ApplicationController
  def index
    OrderService.new.list_orders(current_user)
  end

  def show
    OrderService.new.find_order(params[:id])
  end

  def cancel
    OrderService.new.cancel_order(params[:id])
  end

  def summary
    OrderService.new.summarize(params[:id])
  end

  # Defined on the controller but never routed in config/routes.rb.
  def preview
    OrderService.new.preview_order(params[:id])
  end
end
