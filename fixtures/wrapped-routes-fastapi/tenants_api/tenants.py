from fastapi import APIRouter, Depends, HTTPException

from tenants_api.dependencies import require_admin

router = APIRouter(prefix="/v1/tenants")

store: dict = {}


@router.get("/{tenant_id}")
def read_tenant(tenant_id: str):
    tenant = store.get(tenant_id)
    if tenant is None:
        raise HTTPException(status_code=404, detail="not found")
    return tenant


@router.post("", status_code=201, dependencies=[Depends(require_admin)])
def create_tenant(body: dict):
    if "name" not in body:
        raise ValueError("name is required")
    return {"id": "t1", "name": body["name"]}


@router.delete("/{tenant_id}", status_code=204)
def delete_tenant(tenant_id: str, role: str = Depends(require_admin)):
    store.pop(tenant_id, None)
