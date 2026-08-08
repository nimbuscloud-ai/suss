"""Where the app mounts its namespaces.

`exports` is mounted twice, which is the shape a route on it names no
path for: which mount serves it is not written down anywhere this
reading follows.
"""

from flask_restx import Api

from myapp.behaviors import ns as behaviors_ns
from myapp.exports import ns as exports_ns
from myapp.invoices import ns as invoices_ns
from myapp.reports import ns as reports_ns

api = Api(title="Example API")

api.add_namespace(behaviors_ns)
api.add_namespace(invoices_ns)
api.add_namespace(reports_ns)
api.add_namespace(exports_ns)
api.add_namespace(exports_ns)
