# A client given an API key when it is made, built inside an async
# factory out of a value the config call came back with.

import requests

from config import load_config


class ReportsClient:
    def __init__(self, api_key):
        self.api_key = api_key

    def fetch_daily(self):
        headers = {"X-Api-Key": self.api_key}
        return requests.get("/reports/daily", headers=headers)


async def reports_client():
    config = await load_config()
    return ReportsClient(config["api_key"])
