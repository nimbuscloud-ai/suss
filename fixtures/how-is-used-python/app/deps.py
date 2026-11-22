# The dependency every route that needs a user takes. It refuses anyone
# without a token, so each route that depends on it can end in a 401.

from fastapi import Header, HTTPException
from sqlalchemy.orm import Session


def get_session():
    return Session()


def require_user(authorization: str = Header(None)):
    if not authorization:
        raise HTTPException(status_code=401, detail="Log in first")
    return authorization
