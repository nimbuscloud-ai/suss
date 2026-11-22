# A key-value store on the settings table. Callers pick the row by key,
# some with a key per user and some with one key for the whole site.

from sqlalchemy import select

from app.models import Setting


def lookup(session, key):
    return session.scalars(select(Setting.value).where(Setting.key == key)).first()


def enabled(session, key):
    return lookup(session, key) == "on"
