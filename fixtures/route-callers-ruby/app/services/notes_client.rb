# Calls to the routes in NotesController. A call with a parameter in its
# path calls it something other than the route does.

require "net/http"

class NotesClient
  BASE = "http://localhost:3000"

  def create_note(title)
    Net::HTTP.post(URI("#{BASE}/notes"), title)
  end

  def archive_note(note_id)
    Net::HTTP.post(URI("#{BASE}/notes/#{note_id}/archive"), "")
  end

  def share_note(title)
    Net::HTTP.post(URI("#{BASE}/shared/notes"), title)
  end

  def show_note(note_id)
    Net::HTTP.get_response(URI("#{BASE}/notes/#{note_id}"))
  end
end
