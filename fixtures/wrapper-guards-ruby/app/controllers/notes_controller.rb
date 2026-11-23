# Two filters in front of one action, each rejecting on a test of its
# own, and an action that branches on what it read. The same route is
# written in TypeScript and Python beside this fixture.
class NotesController < ApplicationController
  before_action :require_account
  before_action :require_editor

  def show
    note = NOTES[params[:id]]
    if note
      render json: note
    else
      head :not_found
    end
  end

  private

  def require_account
    if !@account
      head :unauthorized
    end
  end

  def require_editor
    if !@account.can_edit?
      head :forbidden
    end
  end
end
