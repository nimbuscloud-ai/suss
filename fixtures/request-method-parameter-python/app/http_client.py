# Helpers that take the HTTP method from their caller. `fetch` picks its
# requests call by the method it is passed, and the others hand the
# method straight to the library. A caller that passes none sends a GET.

import aiohttp
import httpx
import requests


def fetch(url, method="get", body=None):
    if method == "get":
        return requests.get(url)
    if method == "delete":
        return requests.delete(url)
    return requests.post(url, json=body)


def send(url, method="GET", body=None):
    return requests.request(method, url, json=body)


def send_httpx(url, *, method="GET"):
    return httpx.request(method, url)


async def send_aiohttp(url, method="GET"):
    async with aiohttp.ClientSession() as session:
        return await session.request(method, url)
