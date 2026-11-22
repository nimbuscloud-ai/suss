class OrdersController < ApplicationController
  before_action :require_login

  def index
    @theme = Setting.lookup("user:#{@user.id}:theme")
    render json: Order.where(user_id: @user.id)
  end

  def show
    @theme = Setting.lookup("user:#{current_user_id}:theme")
    render json: Order.find(params[:id])
  end

  def create
    order = Order.create(params.permit(:total))
    if order.total > 100
      Outbound.new.fetch("https://hooks.example.com/big-orders", :post)
    end
    SyncJob.perform_later(order.id)
    render json: order, status: :created
  end
end
