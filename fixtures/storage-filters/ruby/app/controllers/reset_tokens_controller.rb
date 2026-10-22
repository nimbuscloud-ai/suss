# Password reset tokens. `show` filters on `expires` with a range,
# `revoke` deletes by `email`, and nothing reads `note` back.
class ResetTokensController < ApplicationController
  def create
    ResetToken.create(
      token: params[:token],
      email: params[:email],
      expires: 1.hour.from_now,
      note: params[:note]
    )
    head :created
  end

  def show
    valid = ResetToken.where(token: params[:id], expires: Time.current..).pluck(:token).any?
    render json: { valid: valid }
  end

  def revoke
    ResetToken.where(email: params[:email]).delete_all
    head :no_content
  end
end
