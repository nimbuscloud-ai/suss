Rails.application.routes.draw do
  resources :notes, only: [:show]
end
