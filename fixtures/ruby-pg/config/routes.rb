Rails.application.routes.draw do
  resources :accounts, only: [:show, :update]
end
