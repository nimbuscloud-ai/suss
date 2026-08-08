"""A namespace the app mounts twice, under two different paths.

Which mount a route is served under is not something this reading
follows, so the routes here name no path.
"""

from flask_restx import Namespace

ns = Namespace("exports", path="/exports")


@ns.route("/<int:export_id>")
class ExportDetail:
    def get(self, export_id):
        return {}
