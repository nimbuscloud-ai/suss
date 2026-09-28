class Order
  def self.cancel(id)
    { id: id, status: :cancelled }
  end

  def self.refund(id)
    !id.empty?
  end
end
