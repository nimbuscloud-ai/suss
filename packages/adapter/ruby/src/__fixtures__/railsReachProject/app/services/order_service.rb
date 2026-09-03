class OrderService
  def list_orders(user)
    Order.where(user_id: user.id)
  end
end
