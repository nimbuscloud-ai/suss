from flask import abort

from myapp.wrappers.restx import route


@route("/todos")
class TodoList:
    def get(self):
        return []

    def post(self):
        return {}, 201


@route("/todos/<int:todo_id>")
class TodoItem:
    def get(self, todo_id):
        if todo_id > 100:
            abort(404)
        return {"id": todo_id}
