class AccountsController < ApplicationController
  before_action :require_login

  def show
    @banner = Setting.lookup("site:banner")
    render json: @user
  end

  def update
    Outbound.new.fetch("https://hooks.example.com/accounts/#{@user.id}", :put)
    render json: @user
  end
end
