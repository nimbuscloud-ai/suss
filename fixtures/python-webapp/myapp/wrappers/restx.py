"""Internal wrapper around flask-restx.

This fixture is invented for the Python adapter's v0 slice, sourced
from nothing private. It mirrors the shape the language-adapters
proposal measured: one internal wrapper module re-exports flask-restx's
route decorator, and application code imports the wrapper instead of
flask_restx directly.
"""

from flask_restx import Namespace

api = Namespace("app", description="Shared namespace for this service's resources")


def route(path):
    """Re-export of Namespace.route so route files never import flask_restx."""
    return api.route(path)
