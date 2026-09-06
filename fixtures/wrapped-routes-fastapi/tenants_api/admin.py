# A router that registers nothing of its own, so its routes get only what
# the app registers.

from fastapi import APIRouter

router = APIRouter(prefix="/admin")


@router.get("/stats")
def read_stats():
    return {"tenants": 0}
