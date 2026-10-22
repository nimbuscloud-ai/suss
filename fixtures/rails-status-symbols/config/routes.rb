Rails.application.routes.draw do
  resources :keys, only: [:create, :update]
end
