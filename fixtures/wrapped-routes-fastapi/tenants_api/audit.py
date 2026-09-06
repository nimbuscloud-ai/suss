# Routes written in a second file on the router that tenants.py builds, so
# the router's own dependency has to be found through the import.

from tenants_api.tenants import router


@router.get("/{tenant_id}/audit")
def read_audit(tenant_id: str):
    return {"tenant": tenant_id, "events": []}
