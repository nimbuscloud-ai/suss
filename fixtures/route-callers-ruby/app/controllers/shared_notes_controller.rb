class SharedNotesController < ApplicationController
  def create
    render json: { id: 2 }, status: :created
  end
end
