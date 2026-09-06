from typing import Annotated

import fastapi
from fastapi import APIRouter, Depends, HTTPException

from tenants_api.dependencies import (
    require_admin,
    require_caller,
    require_tenant_header,
)

router = APIRouter(
    prefix="/v1/tenants", dependencies=[Depends(require_tenant_header)]
)

store: dict = {}


@router.get("/{tenant_id}")
def read_tenant(tenant_id: str, caller: str = fastapi.Depends(require_caller)):
    # The app already runs require_caller; asking for its value here does not
    # run it a second time.
    def visible(record):
        return record.get("owner") == caller

    tenant = store.get(tenant_id)
    if tenant is None or not visible(tenant):
        raise HTTPException(status_code=404, detail="not found")
    return tenant


@router.post("", status_code=201, dependencies=[Depends(require_admin)])
def create_tenant(body: dict):
    if "name" not in body:
        raise ValueError("name is required")
    return {"id": "t1", "name": body["name"]}


@router.delete("/{tenant_id}", status_code=204)
def delete_tenant(tenant_id: str, role: Annotated[str, Depends(require_admin)]):
    store.pop(tenant_id, None)
