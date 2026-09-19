class AccountsController < ApplicationController
  def show
    render json: repository.find(params[:id])
  end

  def update
    repository.rename(params[:id], params[:name])
    head :no_content
  end

  private

  def repository
    @repository ||= AccountRepository.new
  end
end
