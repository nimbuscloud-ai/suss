/**
 * The Python side of the client URL check: a script that prints the URL
 * httpx and aiohttp would request for each case on stdin, without
 * sending anything. It is kept as a string and written out at run time,
 * as the Python differential's observer is, because this repo keeps
 * checked-in Python to fixtures.
 *
 * httpx builds the request with `Client.build_request`. aiohttp has no
 * public call that builds a URL alone, so a trace hook keeps the URL a
 * request starts with and a resolver stops it at the host lookup, after
 * every check aiohttp makes before it connects. A session that refuses
 * its `base_url` raises when it is built: a refusal of the base.
 */
export const PYTHON_PROBE_SOURCE = `import asyncio
import json
import sys

import aiohttp
import httpx
from aiohttp.abc import AbstractResolver


class Unsent(Exception):
    pass


class StopBeforeResolving(AbstractResolver):
    async def resolve(self, host, port=0, family=0):
        raise Unsent()

    async def close(self):
        pass


def refused(case, error, base):
    return {"id": case["id"], "refused": f"{type(error).__name__}: {error}", "base": base}


def httpx_url(case):
    try:
        client = httpx.Client() if case["base"] is None else httpx.Client(base_url=case["base"])
    except Exception as error:
        return refused(case, error, True)
    with client:
        try:
            url = client.build_request("GET", case["path"]).url
        except Exception as error:
            return refused(case, error, False)
    return {"id": case["id"], "url": str(url)}


async def aiohttp_url(case):
    started = {}

    async def remember_url(session, context, params):
        started["url"] = str(params.url)

    trace = aiohttp.TraceConfig()
    trace.on_request_start.append(remember_url)
    options = {
        "trace_configs": [trace],
        "connector": aiohttp.TCPConnector(resolver=StopBeforeResolving()),
    }
    if case["base"] is not None:
        options["base_url"] = case["base"]
    try:
        session = aiohttp.ClientSession(**options)
    except Exception as error:
        return refused(case, error, True)
    async with session:
        try:
            await session.get(case["path"])
        except Unsent:
            return {"id": case["id"], "url": started["url"]}
        except Exception as error:
            return refused(case, error, False)
    raise RuntimeError(f"aiohttp sent {case['id']} without looking up its host")


async def main():
    results = []
    for case in json.load(sys.stdin):
        if case["library"] == "httpx":
            results.append(httpx_url(case))
        else:
            results.append(await aiohttp_url(case))
    json.dump(results, sys.stdout)


asyncio.run(main())
`;
