# A flask-restx service whose 401 and 500 are produced by code registered
# around the resources, so neither status is anywhere in a resource method.

from flask import Flask, abort, request
from flask_restx import Api, Namespace, Resource

app = Flask(__name__)
api = Api(app)
ns = Namespace("tenants", path="/v1/tenants")


@app.before_request
def require_caller():
    if request.headers.get("authorization") is None:
        return {"error": "unauthorized"}, 401


@api.errorhandler(ValueError)
def on_error(error):
    return {"error": str(error)}, 500


@ns.route("/<string:tenant_id>")
class Tenant(Resource):
    def get(self, tenant_id):
        if tenant_id == "missing":
            abort(404)
        return {"id": tenant_id}


@ns.route("")
class Tenants(Resource):
    def post(self):
        body = request.get_json()
        if "name" not in body:
            raise ValueError("name is required")
        return {"id": "t1"}, 201


api.add_namespace(ns)
