from fastapi import APIRouter

router = APIRouter()


@router.get("/{order_id}")
def read_order(order_id: int):
    return {"id": order_id}
