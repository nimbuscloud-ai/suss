"""Item routes on a prefixed router.

The router carries its own prefix and the app mounts it under a
second one, so every path here is served under "/api/items" even
though neither prefix appears in this file's decorators.
"""

from fastapi import APIRouter


class ItemResponse:
    id: int
    name: str


router = APIRouter(prefix="/items")


@router.get("/{item_id}", response_model=ItemResponse)
def read_item(item_id: int):
    pass


@router.post("", status_code=201, response_model=ItemResponse)
def create_item(payload: ItemResponse):
    pass
