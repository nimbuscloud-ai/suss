from fastapi import Depends, FastAPI

from app.deps import get_session, require_user
from app.outbound import fetch
from app.settings_store import enabled, lookup
from app.tasks import sync_order

app = FastAPI()


@app.get("/orders", dependencies=[Depends(require_user)])
def list_orders(user_id: int):
    theme = lookup(get_session(), f"user:{user_id}:theme")
    return {"theme": theme}


@app.get("/orders/{order_id}", dependencies=[Depends(require_user)])
def read_order(order_id: int, viewer: int):
    theme = lookup(get_session(), f"user:{viewer}:theme")
    return {"id": order_id, "theme": theme}


@app.post("/orders", dependencies=[Depends(require_user)])
def create_order(total: int):
    if total > 100:
        fetch("https://hooks.example.com/big-orders", "post")
    sync_order.delay(1)
    return {"total": total}


@app.get("/account")
def read_account():
    if not enabled(get_session(), "site:accounts"):
        return {"banner": None}
    return {"banner": lookup(get_session(), "site:banner")}


@app.put("/account", dependencies=[Depends(require_user)])
def update_account(account_id: int):
    fetch(f"https://hooks.example.com/accounts/{account_id}")
    return {"id": account_id}
