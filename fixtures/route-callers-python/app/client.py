# Calls to the routes in main.py. A call with a parameter in its path
# calls it something other than the route does.

import httpx

BASE = "http://localhost:8000"


def create_note(title):
    return httpx.post(f"{BASE}/notes", json={"title": title}).status_code


def archive_note(note_id):
    return httpx.post(f"{BASE}/notes/{note_id}/archive").status_code


def share_note(title):
    return httpx.post(f"{BASE}/shared/notes", json={"title": title}).status_code


def show_note(note_id):
    response = httpx.get(f"{BASE}/notes/{note_id}")
    if response.status_code != 200:
        return None
    return response.json()
