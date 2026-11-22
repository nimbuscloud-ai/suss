Rails.application.routes.draw do
  resources :orders, only: [:index, :show, :create]
  resource :account, only: [:show, :update]
end
