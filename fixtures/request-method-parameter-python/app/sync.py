# The script a scheduler runs as `python -m app.sync`, which makes every
# call above.

import asyncio

from app.grants import (
    audit,
    create_grant,
    list_grants,
    purge_grant,
    renew_grant,
    revoke_grant,
    watch_grants,
)

list_grants()
create_grant({})
revoke_grant("g1")
renew_grant("g1")
audit()
purge_grant("g1")
asyncio.run(watch_grants())
