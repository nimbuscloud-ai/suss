"""A namespace the app mounts twice, both times where its constructor
put it.

Both mounts land the routes at the same path, so the reading composes
it; two mounts that landed at different paths would say nothing.
"""

from flask_restx import Namespace

ns = Namespace("exports", path="/exports")


@ns.route("/<int:export_id>")
class ExportDetail:
    def get(self, export_id):
        return {}
