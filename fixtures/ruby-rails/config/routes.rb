Rails.application.routes.draw do
  resources :orders do
    member do
      post :cancel
    end

    resources :items
  end

  get "/orders/:id/summary", to: "orders#summary"

  resource :profile, only: [:show, :update]

  namespace :admin do
    resources :reports, only: [:index]
  end

  mount Sidekiq::Web => "/sidekiq"
end
