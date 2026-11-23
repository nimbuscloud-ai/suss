# Every outbound request goes through here, with the verb the caller
# passes deciding which httpx call runs.

import httpx


class Refused(Exception):
    pass


def fetch(url, method="get"):
    if not url.startswith("https://"):
        raise Refused()
    if method == "post":
        return httpx.post(url)
    return httpx.get(url)
