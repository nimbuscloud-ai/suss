# Runs in ApiFunction. TABLE_NAME is declared on that function and read
# when the module loads. ASSET_BUCKET is declared nowhere, so the route
# that reads it is a finding.

import os

from fastapi import FastAPI
from mangum import Mangum

from settings import PAGE_SIZE

app = FastAPI()

TABLE = os.environ["TABLE_NAME"]


@app.get("/items")
def list_items():
    bucket = os.environ["ASSET_BUCKET"]
    return {"table": TABLE, "bucket": bucket, "page_size": PAGE_SIZE}


handler = Mangum(app)
