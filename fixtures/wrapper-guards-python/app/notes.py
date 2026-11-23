# Two dependencies in front of one route, each rejecting on a test of its
# own, and a handler that branches on what it read. The same route is
# written in TypeScript and Ruby beside this fixture.

from fastapi import APIRouter, Depends, HTTPException, Request

router = APIRouter()

notes: dict = {}


def signed_in(request: Request) -> bool: ...


def can_edit(request: Request) -> bool: ...


def require_account(request: Request):
    if not signed_in(request):
        raise HTTPException(status_code=401, detail="sign in first")


def require_editor(request: Request):
    if not can_edit(request):
        raise HTTPException(status_code=403, detail="editors only")


@router.get(
    "/notes/{id}",
    dependencies=[Depends(require_account), Depends(require_editor)],
)
def read_note(id: str):
    note = notes.get(id)
    if not note:
        raise HTTPException(status_code=404, detail="no such note")
    return note
