class OrdersController < ApplicationController
  def index
    render json: Order.where(status: "open")
  end

  def show
    render json: Order.find(params[:id])
  end
end
