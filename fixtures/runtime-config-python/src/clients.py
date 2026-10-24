# Imported by worker.py. Building a QueueClient runs __init__, so the
# read inside it happens wherever the worker builds one.

import os


class QueueClient:
    def __init__(self):
        self.url = os.environ["QUEUE_URL"]
