class ItemsController < ApplicationController
  def index
    OrderService.new.list_items(params[:order_id])
  end

  def create
    render json: OrderService.new.list_items(params[:order_id]), status: :created
  end

  def destroy
    OrderService.new.find_order(params[:id])
    head :no_content
  end
end
