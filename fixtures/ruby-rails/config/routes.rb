Rails.application.routes.draw do
  resources :orders do
    member do
      post :cancel
    end

    resources :items do
      member do
        post :archive
      end
    end
  end

  get "/orders/:id/summary", to: "orders#summary"

  resource :profile, only: [:show, :update]

  resources :receipts, only: [:show, :destroy]

  namespace :admin do
    resources :reports, only: [:index]
    resources :audits, only: [:index]
  end

  namespace :api do
    resource :settings, only: [:show, :update]
  end

  mount Sidekiq::Web => "/sidekiq"
end
