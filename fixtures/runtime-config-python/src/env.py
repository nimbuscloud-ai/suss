# Imported by both functions. Each caller passes a variable its own
# function declares, so the read belongs to the call that passed the
# name, and neither function is charged with the other's variable.

import os


def require_env(name):
    return os.environ[name]
