class ReceiptsController < ApplicationController
  # A browser gets a redirect and an API client gets JSON, so each format
  # block is an outcome of its own.
  def show
    respond_to do |format|
      format.html { redirect_to "/orders" }
      format.json { render json: {}, status: :ok }
    end
  end

  # The helper responds for every format, with the status this call passes.
  def destroy
    respond_with_error(410)
  end

  private

  def respond_with_error(code)
    respond_to do |format|
      format.any { head code }
      format.json { render json: { error: "gone" }, status: code }
    end
  end
end
