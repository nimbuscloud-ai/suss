from fastapi import FastAPI


class Holder:
    def __init__(self):
        self.app = FastAPI()

    def wire(self):
        @self.app.get("/p05")
        def five():
            return {"n": 5}
