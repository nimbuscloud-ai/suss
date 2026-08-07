from myapp.wrappers.restx import route


@route("/users")
class UserList:
    def get(self):
        return []
