# Routes that share words with each other, so a question about one of
# them has to leave the others out.

class NotesController < ApplicationController
  def show
    render json: { id: params[:id] }
  end

  def edit
    redirect_to "/login"
  end

  def create
    if params[:title].blank?
      render json: { error: "title is required" }, status: :unprocessable_entity
      return
    end
    render json: { id: 1 }, status: :created
  end

  def archive
    head :no_content
  end
end
