class ItemsController < ApplicationController
  def index
    OrderService.new.list_items(params[:order_id])
  end
end
