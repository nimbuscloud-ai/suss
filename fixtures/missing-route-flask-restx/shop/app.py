from flask import Blueprint, Flask, send_file
from flask_restx import Api, Namespace, Resource

app = Flask(__name__)

api_blueprint = Blueprint("api", __name__, url_prefix="/api")
api = Api(api_blueprint)
orders = Namespace("orders", path="/orders")
files = Namespace("files", path="/files")

downloads = Blueprint("downloads", __name__, url_prefix="/downloads")


# Renamed from `summary`, and the storefront still calls the old name.
@orders.route("/<int:order_id>/totals")
class OrderTotals(Resource):
    def get(self, order_id):
        return {"id": order_id, "total": 42}


@files.route("/<path:key>")
class StoredFile(Resource):
    def get(self, key):
        return {"key": key}


@downloads.route("/<int:order_id>/invoice.pdf")
def invoice(order_id):
    return send_file(f"invoices/{order_id}.pdf")


api.add_namespace(orders)
api.add_namespace(files)
app.register_blueprint(api_blueprint)
app.register_blueprint(downloads)
