"""A namespace whose path is written as a module constant.

The constant is followed to the string it was assigned, so the routes
here come out with the path flask-restx serves them under.
"""

from flask_restx import Namespace

REPORTS_PATH = "/reports"

ns = Namespace("reports", path=REPORTS_PATH)


@ns.route("/<int:report_id>")
class ReportDetail:
    def get(self, report_id):
        return {}
