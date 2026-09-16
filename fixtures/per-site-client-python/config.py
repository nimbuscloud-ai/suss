# Runtime configuration, read once and awaited by whoever builds a
# client out of it.

import requests


async def load_config():
    response = requests.get("/config")
    return response.json()
