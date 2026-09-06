# The dependency the app registers, written in its own file.

from fastapi import HTTPException, Request


def require_caller(request: Request):
    if request.headers.get("authorization") is None:
        raise HTTPException(status_code=401, detail="unauthorized")
    return request.headers["authorization"]


def require_tenant_header(request: Request):
    if request.headers.get("x-tenant") is None:
        raise HTTPException(status_code=400, detail="x-tenant header required")


def require_admin(request: Request):
    if request.headers.get("x-role") != "admin":
        raise HTTPException(status_code=403, detail="forbidden")
