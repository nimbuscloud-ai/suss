Rails.application.routes.draw do
  get "/players/:id/stats", to: "players#stats"
  get "/players/export", to: "exports#index"
  get "/leaderboard", to: "leaderboards#show"
  get "/admin/players", to: "leaderboards#dump"
end
