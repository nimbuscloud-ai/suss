Rails.application.routes.draw do
  resources :rollups, only: [:index]
end
