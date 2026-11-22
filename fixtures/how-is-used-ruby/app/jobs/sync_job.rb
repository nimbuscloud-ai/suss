class SyncJob < ApplicationJob
  def perform(order_id)
    return unless Setting.enabled?("sync:orders")

    Outbound.new.fetch("https://api.example.com/sync/#{order_id}", :post)
  end
end
