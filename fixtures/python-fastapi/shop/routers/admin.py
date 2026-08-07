"""Admin routes on a router the app mounts with a computed prefix.

The mount call in main.py passes prefix=admin_prefix(), which is not
a string literal, so routes here are discovered by name with no path.
"""

from fastapi import APIRouter

router = APIRouter(prefix="/admin")


@router.get("/stats")
def admin_stats():
    pass
