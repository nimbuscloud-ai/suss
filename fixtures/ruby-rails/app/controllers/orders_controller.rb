class OrdersController < ApplicationController
  def index
    OrderService.new.list_orders(current_user)
  end

  def show
    OrderService.new.find_order(params[:id])
  end

  def cancel
    authorize_order!(params[:id])
    OrderService.new.cancel_order(params[:id])
  end

  def summary
    OrderService.new.summarize(params[:id])
  end

  # Defined on the controller but never routed in config/routes.rb.
  def preview
    OrderService.new.preview_order(params[:id])
  end

  private

  # Not an action: Rails dispatches to a public method only.
  def authorize_order!(id)
    OrderService.new.find_order(id)
  end
end
