"""The app for the FastAPI fixture project.

This fixture is invented for the FastAPI pack (sourced from nothing
private). It covers the shapes the pack reads and the two it abstains
on: plain routes on the app, a prefixed router mounted under a second
prefix, a route path built at runtime, and a mount whose prefix is
computed.
"""

from fastapi import FastAPI

from shop.routers.admin import router as admin_router
from shop.routers.items import router as items_router

app = FastAPI()

REPORT_SECTION = "summary"


class HealthStatus:
    ok: bool


def admin_prefix():
    return "/internal"


@app.get("/health", response_model=HealthStatus)
def health():
    pass


@app.post("/orders", status_code=201)
def create_order():
    pass


@app.get("/reports/" + REPORT_SECTION)
def report():
    pass


app.include_router(items_router, prefix="/api")
app.include_router(admin_router, prefix=admin_prefix())
