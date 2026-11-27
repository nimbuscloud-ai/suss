class FeedsController < ActionController::Metal
  def show
    self.content_type = "application/json"
    self.response_body = "[]"
  end
end
