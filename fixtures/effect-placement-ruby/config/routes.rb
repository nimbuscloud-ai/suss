Rails.application.routes.draw do
  resources :items, only: [:create, :update, :destroy]
end
