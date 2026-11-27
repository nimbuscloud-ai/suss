from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from prometheus_client import make_asgi_app

from app.orders import router as orders

app = FastAPI()
app.include_router(orders, prefix="/orders")
app.mount("/assets", StaticFiles(directory="assets"), name="assets")
app.mount("/metrics", make_asgi_app())


@app.get("/files/{key:path}")
def download(key: str):
    return {"key": key}
