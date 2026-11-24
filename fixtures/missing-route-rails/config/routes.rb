Rails.application.routes.draw do
  # Renamed from `summary`, and the storefront still calls the old name.
  get "/orders/:id/totals", to: "orders#totals"

  mount Sidekiq::Web => "/jobs"
end
