# A player's stats on screen. The CSV export reads the same golden count.
class PlayersController < ApplicationController
  def stats
    player = Player.select(:name, :games, :golden).find_by(id: params[:id])
    if player.nil?
      render json: { error: "no such player" }, status: :not_found
      return
    end

    render json: { name: player.name, games: player.games, golden: player.golden }
  end
end
