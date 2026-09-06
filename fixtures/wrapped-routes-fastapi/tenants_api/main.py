# A FastAPI service whose 401, 429 and 500 are produced by code registered
# around the routes, so none of those statuses is anywhere in a handler.

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse

from tenants_api.dependencies import require_caller
from tenants_api.tenants import router as tenants

app = FastAPI(dependencies=[Depends(require_caller)])


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    if request.headers.get("x-burst") is not None:
        return JSONResponse({"error": "slow down"}, status_code=429)
    return await call_next(request)


@app.exception_handler(ValueError)
async def on_error(request: Request, exc: ValueError):
    return JSONResponse({"error": str(exc)}, status_code=500)


app.include_router(tenants)


@app.get("/health")
def health():
    return {"status": "ok"}
