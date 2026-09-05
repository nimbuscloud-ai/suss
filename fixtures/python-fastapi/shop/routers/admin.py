"""Admin routes on a router the app mounts with a prefix from the environment.

The mount call in main.py passes prefix=settings.admin_prefix, which
the source never states, so routes here are discovered by name with no path.
"""

from fastapi import APIRouter

router = APIRouter(prefix="/admin")


@router.get("/stats")
def admin_stats():
    pass
