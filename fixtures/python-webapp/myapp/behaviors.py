"""Resources declared on a namespace, mounted with add_namespace.

Invented for the Python adapter, sourced from nothing private. It
mirrors the shape a production flask-restx service is written in: one
module-level namespace holding the path, routes written relative to it,
and one resource sitting at the mount point itself, written with an
empty route path.
"""

from flask_restx import Namespace

ns = Namespace("behaviors", path="/behaviors/<int:school_id>")


@ns.route("")
class BehaviorList:
    def get(self, school_id):
        return []


@ns.route("/<int:behavior_id>")
class BehaviorDetail:
    def get(self, school_id, behavior_id):
        return {}
