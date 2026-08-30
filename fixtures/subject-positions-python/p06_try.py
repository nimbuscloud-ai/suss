from fastapi import FastAPI

try:
    app = FastAPI()

    @app.get("/p06")
    def six():
        return {"n": 6}
except RuntimeError:
    pass
