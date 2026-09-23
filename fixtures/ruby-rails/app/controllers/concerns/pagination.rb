module Pagination
  def page_size
    OrderService.new.list_orders(current_user)
  end
end
