Rails.application.routes.draw do
  resources :exports, only: [:create, :update, :destroy]
end
