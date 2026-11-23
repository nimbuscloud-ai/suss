# The script a scheduler runs as `python -m app.sync`, which makes every
# call above. The method `relay` passes on comes from the command line.

import sys

from app.grants import (
    audit,
    create_grant,
    list_grants,
    relay,
    renew_grant,
    revoke_grant,
)

list_grants()
create_grant({})
revoke_grant("g1")
relay("g1", sys.argv[1])
renew_grant("g1")
audit()
