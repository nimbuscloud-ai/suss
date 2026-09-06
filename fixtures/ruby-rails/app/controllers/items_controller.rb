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

  # Two responses down two branches. There is no model in this fixture, so
  # the validation branch tests a parameter instead of a save.
  def update
    if params[:name].blank?
      render json: { error: "name is required" }, status: :unprocessable_entity
    else
      OrderService.new.list_items(params[:order_id])
      render json: {}, status: :ok
    end
  end

  def destroy
    OrderService.new.find_order(params[:id])
    head :no_content
  end

  # A redirect writes no status of its own and sends 302, where every other
  # action here defaults to 200.
  def archive
    redirect_to "/orders/#{params[:order_id]}/items"
  end

  private

  def visible_items
    OrderService.new.list_items(params[:order_id])
  end
end
