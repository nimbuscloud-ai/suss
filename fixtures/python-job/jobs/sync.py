# A job a scheduler runs as `python -m jobs.sync`. There is no handler
# here: the work runs while the module loads.

import asyncio
import os
import sys

from jobs.accounts import archive_accounts, count_orders, sync_accounts
from jobs.settings import make_pool, read_settings

settings = read_settings()
pool = make_pool(settings)

sync_accounts(pool, settings["batch_size"])

if os.environ.get("ARCHIVE_ON_START") == "1":
    archive_accounts(pool)


async def main():
    await asyncio.sleep(0)
    return count_orders(pool)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
