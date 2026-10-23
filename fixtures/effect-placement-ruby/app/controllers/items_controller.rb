# Actions that respond early and write afterwards: a guard before the
# write, a check inside a loop of writes, and cleanup in an `ensure`.
# The same routes are written in TypeScript and Python beside this fixture.
class ItemsController < ApplicationController
  def update
    item = Item.find_by(id: params[:id])
    return head :not_found unless item
    return head :forbidden if item.owner_id != params[:owner_id]

    item.update!(title: params[:title])
    render json: item
  end

  def create
    params[:titles].each do |title|
      return head :bad_request if title.blank?
      Item.create!(title: title, owner_id: 1)
    end
    Audit.create!(action: "bulk")
    head :created
  end

  def destroy
    return head :bad_request if params[:id].blank?

    begin
      item = Item.find_by(id: params[:id])
      return head :not_found unless item
      Item.where(id: item.id).delete_all
      head :ok
    ensure
      Audit.create!(action: "delete")
    end
  end
end
