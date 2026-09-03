class OrdersController < ApplicationController
  def index
    OrderService.new.list_orders(current_user)
  end
end
