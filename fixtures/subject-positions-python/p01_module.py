from fastapi import FastAPI

app = FastAPI()


@app.get("/p01")
def one():
    return {"n": 1}
