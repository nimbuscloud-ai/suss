Rails.application.routes.draw do
  resources :reset_tokens, only: [:create, :show] do
    collection do
      delete :revoke
    end
  end
end
