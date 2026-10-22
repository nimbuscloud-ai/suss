# Both actions send 422 with the symbol Rack 3 renamed it to. `create`
# writes the symbol at the render. `update` picks it in a branch and
# renders once, as mastodon's webauthn credentials controller does.
class KeysController < ApplicationController
  def create
    if params[:credential].present?
      render json: { ok: true }, status: :created
    else
      render json: { error: "invalid credential" }, status: :unprocessable_content
    end
  end

  def update
    if params[:nickname].present?
      status = :ok
    else
      status = :unprocessable_content
    end
    render json: { redirect_path: "/keys" }, status: status
  end
end
