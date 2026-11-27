from fastapi import APIRouter

router = APIRouter()


# Renamed from `summary`, and the sync job still calls the old name.
@router.get("/{order_id}/totals")
def totals(order_id: str):
    return {"id": order_id, "total": 42}
