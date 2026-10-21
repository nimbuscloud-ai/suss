# A player's stats on screen, and the same stats as a CSV download.
# Both read the golden count from the players table.

from fastapi import Depends, FastAPI
from fastapi.responses import PlainTextResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Player

app = FastAPI()


def get_session() -> Session:
    return Session()


@app.get("/players/{player_id}/stats")
def player_stats(player_id: int, session: Session = Depends(get_session)):
    query = select(Player.name, Player.games, Player.golden).where(
        Player.id == player_id
    )
    row = session.execute(query).one()
    return {"name": row.name, "games": row.games, "golden": row.golden}


@app.get("/players/export.csv")
def export_players(session: Session = Depends(get_session)):
    query = select(Player.name, Player.games, Player.golden)
    rows = session.execute(query).all()
    lines = [f"{row.name},{row.games},{row.golden}" for row in rows]
    return PlainTextResponse("\n".join(["name,games,golden", *lines]))
