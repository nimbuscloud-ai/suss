# The orders search route. The gateway checks the caller's token and
# passes the tenant it names in the X-Tenant-Id header, so the query
# takes the tenant from there and never from the body the caller wrote.

from fastapi import Depends, FastAPI, Header
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Order
from app.tokens import decode_tenant

app = FastAPI()


class OrderFilter(BaseModel):
    tenant_id: str
    status: str


def get_session() -> Session:
    return Session()


@app.post("/orders/search")
def search_orders(
    filters: OrderFilter,
    x_tenant_id: str = Header(),
    authorization: str = Header(),
    session: Session = Depends(get_session),
):
    query = select(Order).where(Order.tenant_id == x_tenant_id)
    return session.scalars(query).all()
