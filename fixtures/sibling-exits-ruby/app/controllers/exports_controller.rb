# Every player's stats as a CSV file, for the weekly spreadsheet.
class ExportsController < ApplicationController
  def index
    rows = Player.pluck(:name, :games, :golden)
    lines = rows.map { |name, games, golden| [name, games, golden].join(",") }
    send_data ["name,games,golden", *lines].join("\n"), type: "text/csv", filename: "players.csv"
  end
end
