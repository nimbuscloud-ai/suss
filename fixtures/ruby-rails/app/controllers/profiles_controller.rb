# Routed by `resource :profile`, singular, so every path has no :id and
# the plural controller name is what routing looks for.
class ProfilesController < ApplicationController
  def show
    OrderService.new.find_order(params[:id])
  end

  def update
    OrderService.new.cancel_order(params[:id])
  end
end
