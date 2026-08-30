from fastapi import FastAPI


def make():
    app = FastAPI()

    @app.get("/p02")
    def two():
        return {"n": 2}

    return app
