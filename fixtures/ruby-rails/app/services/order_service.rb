class OrderService
  def list_orders(user)
    Order.where(user_id: user.id)
  end

  def find_order(id)
    Order.find(id)
  end

  def cancel_order(id)
    Order.find(id).update(status: "cancelled")
  end

  def summarize(id)
    Order.find(id)
  end

  def list_items(order_id)
    Order.find(order_id)
  end

  def preview_order(id)
    Order.find(id)
  end
end
