"""A namespace whose path is written with a trailing slash.

flask-restx holds a namespace's path with trailing slashes stripped, so
these resources are served under /invoices, not /invoices/.
"""

from flask_restx import Namespace

ns = Namespace("invoices", path="/invoices/")


@ns.route("")
class InvoiceList:
    def get(self):
        return []


@ns.route("/<int:invoice_id>")
class InvoiceDetail:
    def get(self, invoice_id):
        return {}
