# The leaderboard and the admin dump. The leaderboard doesn't read the
# golden count, and the dump reads every column without naming any.

from fastapi import Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Player
from app.players import app, get_session


@app.get("/leaderboard")
def leaderboard(session: Session = Depends(get_session)):
    query = select(Player.name, Player.games).order_by(Player.games.desc())
    rows = session.execute(query).all()
    return [{"name": row.name, "games": row.games} for row in rows]


@app.get("/admin/players")
def dump_players(session: Session = Depends(get_session)):
    return session.scalars(select(Player)).all()
