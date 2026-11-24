# Requests whose method or URL a branch before the call picks. Each
# branch that changes the request is a request of its own; the last
# helper's branch changes neither, so it makes one request.

require "faraday"

class SprocketClient
  def save_sprocket(sprocket)
    target = sprocket[:id] ? { method: :patch, url: "https://api.example.com/sprockets/#{sprocket[:id]}" } : { method: :post, url: "https://api.example.com/sprockets" }
    Faraday.new.run_request(target[:method], target[:url], sprocket.to_json, {})
  end

  def load_gizmo(gizmo_id)
    url = gizmo_id ? "https://api.example.com/gizmos/#{gizmo_id}" : "https://api.example.com/gizmos"
    Faraday.get(url)
  end

  def toggle_widget(on)
    verb = on ? :put : :delete
    Faraday.new.run_request(verb, "https://api.example.com/widgets/current", nil, {})
  end

  def fetch_report(period)
    case period
    when "day"
      path = "/reports/daily"
    when "week", "fortnight"
      path = "/reports/weekly"
    else
      path = "/reports/all"
    end
    Faraday.get("https://api.example.com#{path}")
  end

  def ping_doohickey(verbose)
    url = verbose ? "https://api.example.com/doohickeys/ping" : "https://api.example.com/doohickeys/ping"
    Faraday.post(url)
  end
end
