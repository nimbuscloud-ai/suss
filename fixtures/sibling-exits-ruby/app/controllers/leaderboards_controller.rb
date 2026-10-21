# The leaderboard and the admin dump. The leaderboard doesn't read the
# golden count, and the dump reads every column without naming any.
class LeaderboardsController < ApplicationController
  def show
    render json: Player.order(games: :desc).pluck(:name, :games)
  end

  def dump
    render json: Player.all
  end
end
