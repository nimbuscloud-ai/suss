# Where the job gets its connection from. Nothing here is a handler.

import os

from sqlalchemy import create_engine


def read_settings():
    return {
        "dsn": os.environ["ACCOUNTS_DSN"],
        "batch_size": int(os.environ.get("BATCH_SIZE", "100")),
    }


def make_pool(settings):
    return create_engine(settings["dsn"]).connect()
