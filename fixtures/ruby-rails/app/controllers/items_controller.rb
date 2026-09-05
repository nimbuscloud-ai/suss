class ItemsController < ApplicationController
  def index
    OrderService.new.list_items(params[:order_id])
  end

  # Calls a private helper by its bare name, with no arguments and no
  # parentheses, which is a call on self in Ruby.
  def show
    visible_items
  end

  def create
    render json: OrderService.new.list_items(params[:order_id]), status: :created
  end

  def destroy
    OrderService.new.find_order(params[:id])
    head :no_content
  end

  private

  def visible_items
    OrderService.new.list_items(params[:order_id])
  end
end
