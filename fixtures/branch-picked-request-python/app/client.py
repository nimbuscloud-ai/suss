# Requests whose method or URL a branch before the call picks. Each
# branch that changes the request is a request of its own; the last
# helper's branch changes neither, so it makes one request.

import requests

API = "https://api.example.com"


def save_sprocket(sprocket):
    target = (
        {"method": "PATCH", "url": f"{API}/sprockets/{sprocket['id']}"}
        if sprocket.get("id")
        else {"method": "POST", "url": f"{API}/sprockets"}
    )
    return requests.request(target["method"], target["url"], json=sprocket)


def load_gizmo(gizmo_id):
    url = f"{API}/gizmos/{gizmo_id}" if gizmo_id else f"{API}/gizmos"
    return requests.get(url)


def toggle_widget(on):
    method = "PUT" if on else "DELETE"
    return requests.request(method, f"{API}/widgets/current")


def fetch_report(period):
    if period == "day":
        path = "/reports/daily"
    elif period == "week":
        path = "/reports/weekly"
    else:
        path = "/reports/all"
    return requests.get(f"{API}{path}")


def ping_doohickey(verbose):
    url = f"{API}/doohickeys/ping" if verbose else f"{API}/doohickeys/ping"
    return requests.post(url)
