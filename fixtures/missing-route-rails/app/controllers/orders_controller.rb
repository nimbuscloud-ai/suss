class OrdersController < ApplicationController
  def totals
    render json: { id: params[:id], total: 42 }
  end
end
