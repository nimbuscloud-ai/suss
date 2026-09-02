# Imported by app.py, so it runs in ApiFunction. The one read has a
# fallback, so nothing is wrong when the function does not declare it.

import os

PAGE_SIZE = int(os.environ.get("PAGE_SIZE", "20"))
