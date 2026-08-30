from fastapi import FastAPI


def outer():
    def inner():
        app = FastAPI()

        @app.get("/p03")
        def three():
            return {"n": 3}

        return app

    return inner()
