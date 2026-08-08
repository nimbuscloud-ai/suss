"""A namespace whose path is not written as a literal.

Nothing here reads what REPORTS_PATH holds, so the routes on this
namespace name no path rather than one composed from a guess.
"""

from flask_restx import Namespace

REPORTS_PATH = "/reports"

ns = Namespace("reports", path=REPORTS_PATH)


@ns.route("/<int:report_id>")
class ReportDetail:
    def get(self, report_id):
        return {}
