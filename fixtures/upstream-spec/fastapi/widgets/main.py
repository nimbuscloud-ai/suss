from fastapi import FastAPI, HTTPException

app = FastAPI()


@app.get("/api/v1/widgets")
def list_widgets():
    return [{"id": "w1", "name": "Spanner"}]


@app.get("/api/v1/widgets/{id}")
def get_widget(id: str):
    if id == "":
        raise HTTPException(status_code=404, detail="id is required")
    return {"id": id, "name": "Spanner"}
