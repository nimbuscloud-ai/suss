# Password reset tokens. `redeem` filters on `expires` with a range,
# `revoke` deletes by `email`, and nothing reads `note` back.

from datetime import datetime, timedelta

from fastapi import Depends, FastAPI
from sqlalchemy import Column, DateTime, String, delete, insert, select
from sqlalchemy.orm import DeclarativeBase, Session

app = FastAPI()


class Base(DeclarativeBase):
    pass


class ResetToken(Base):
    __tablename__ = "ResetToken"

    token = Column(String, primary_key=True)
    email = Column(String)
    expires = Column(DateTime)
    note = Column(String)


def get_session() -> Session:
    return Session()


@app.post("/tokens")
def issue(token: str, email: str, note: str, session: Session = Depends(get_session)):
    session.execute(
        insert(ResetToken).values(
            token=token,
            email=email,
            expires=datetime.now() + timedelta(hours=1),
            note=note,
        )
    )
    return {"issued": True}


@app.get("/tokens/{token}")
def redeem(token: str, session: Session = Depends(get_session)):
    found = session.scalars(
        select(ResetToken.token).where(
            ResetToken.token == token, ResetToken.expires >= datetime.now()
        )
    ).first()
    return {"valid": found is not None}


@app.delete("/tokens")
def revoke(email: str, session: Session = Depends(get_session)):
    session.execute(delete(ResetToken).where(ResetToken.email == email))
    return {"revoked": True}
