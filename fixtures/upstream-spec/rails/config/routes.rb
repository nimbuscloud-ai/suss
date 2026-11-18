Rails.application.routes.draw do
  namespace :api do
    namespace :v1 do
      resources :widgets, only: [:index, :show]
    end
  end
end
