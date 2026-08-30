from fastapi import FastAPI


class Builder:
    def build(self):
        app = FastAPI()

        @app.get("/p04")
        def four():
            return {"n": 4}

        return app
