Rails.application.routes.draw do
  # Renamed from `summary`, and the storefront still calls the old name.
  get "/orders/:id/totals", to: "orders#totals"

  # Served by a controller built on ActionController::Metal.
  get "/orders/:id/feed", to: "feeds#show"

  mount Sidekiq::Web => "/jobs"
end
