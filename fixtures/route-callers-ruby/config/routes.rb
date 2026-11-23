Rails.application.routes.draw do
  resources :notes, only: [:show, :edit, :create] do
    member do
      post :archive
    end
  end
  post "shared/notes", to: "shared_notes#create"
end
