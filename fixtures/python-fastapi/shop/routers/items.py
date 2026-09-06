"""Item routes on a prefixed router.

The router carries its own prefix and the app mounts it under a
second one, so every path here is served under "/api/items" even
though neither prefix appears in this file's decorators.

create_item also takes a dependency. FastAPI resolves it and passes it
in, so it is no part of the request even though it is annotated with a
local class, the same way a request body is.
"""

from fastapi import APIRouter, Depends, HTTPException


class ItemResponse:
    id: int
    name: str


class User:
    id: int


def current_user() -> User:
    pass


router = APIRouter(prefix="/items")


@router.get("/{item_id}", response_model=ItemResponse)
def read_item(item_id: int):
    pass


@router.post("", status_code=201, response_model=ItemResponse)
def create_item(payload: ItemResponse, user: User = Depends(current_user)):
    pass


@router.get("/{item_id}/stock")
def read_stock(item_id: int):
    if item_id > 10:
        raise HTTPException(status_code=404, detail="no such item")
    return {"count": 1}
