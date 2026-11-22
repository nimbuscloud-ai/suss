from celery import Celery

from app.deps import get_session
from app.outbound import fetch
from app.settings_store import enabled

celery_app = Celery("shop")


@celery_app.task(name="orders.sync")
def sync_order(order_id):
    if not enabled(get_session(), "sync:orders"):
        return None
    return fetch(f"https://api.example.com/sync/{order_id}", "post")
