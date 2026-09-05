"""The app for the FastAPI fixture project.

This fixture is invented for the FastAPI pack (sourced from nothing
private). It covers the shapes the pack reads and the two it abstains
on: plain routes on the app, a prefixed router mounted under a second
prefix, a route path read from the environment, and a mount whose
prefix is read from the environment.
"""

from fastapi import FastAPI

from shop.config import settings
from shop.routers.admin import router as admin_router
from shop.routers.items import router as items_router

app = FastAPI()


class HealthStatus:
    ok: bool


@app.get("/health", response_model=HealthStatus)
def health():
    pass


@app.post("/orders", status_code=201)
def create_order():
    pass


@app.get(settings.report_path)
def report():
    pass


app.include_router(items_router, prefix="/api")
app.include_router(admin_router, prefix=settings.admin_prefix)
