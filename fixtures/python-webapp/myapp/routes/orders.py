from myapp.wrappers.restx import route as api_route


@api_route("/orders/<int:order_id>")
class OrderDetail:
    def get(self, order_id):
        return {}

    def delete(self, order_id):
        return {}, 204
