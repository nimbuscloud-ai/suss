# Routes that respond early and write afterwards: a guard before the
# write, a check inside a loop of writes, and cleanup in a `finally`.
# The same routes are written in TypeScript and Ruby beside this fixture.

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Field, Session, SQLModel

router = APIRouter()


class Item(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    title: str
    owner_id: int


class Audit(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    action: str


def get_session() -> Session:
    return Session()


@router.put("/items/{id}")
def update_item(
    id: int, title: str, owner_id: int, session: Session = Depends(get_session)
):
    item = session.get(Item, id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    if item.owner_id != owner_id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    item.title = title
    session.add(item)
    session.commit()
    return item


@router.post("/items", status_code=201)
def create_items(titles: list[str], session: Session = Depends(get_session)):
    for title in titles:
        if not title:
            raise HTTPException(status_code=400, detail="empty title")
        session.add(Item(title=title, owner_id=1))
    session.add(Audit(action="bulk"))
    session.commit()
    return {"ok": True}


@router.delete("/items/{id}")
def delete_item(id: int, session: Session = Depends(get_session)):
    if id <= 0:
        raise HTTPException(status_code=400, detail="no id")
    try:
        item = session.get(Item, id)
        if not item:
            raise HTTPException(status_code=404, detail="Item not found")
        session.delete(item)
        return {"ok": True}
    finally:
        session.add(Audit(action="delete"))
        session.commit()
