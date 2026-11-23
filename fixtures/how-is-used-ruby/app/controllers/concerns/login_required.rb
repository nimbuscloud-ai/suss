# The filter every controller that needs a user runs first. It sends
# anyone without one to the login page, so each route it wraps can end
# in a 302.

module LoginRequired
  def require_login
    redirect_to "/login" unless @user
  end
end
