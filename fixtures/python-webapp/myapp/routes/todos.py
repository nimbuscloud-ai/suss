from myapp.wrappers.restx import route


@route("/todos")
class TodoList:
    def get(self):
        return []

    def post(self):
        return {}, 201
