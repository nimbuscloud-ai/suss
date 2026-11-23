# Routes that share words with each other, so a question about one of
# them has to leave the others out.

from fastapi import FastAPI, HTTPException

app = FastAPI()


@app.post("/notes", status_code=201)
def create_note(title: str):
    if not title:
        raise HTTPException(status_code=422, detail="title is required")
    return {"id": 1}


@app.post("/notes/{id}/archive", status_code=204)
def archive_note(id: int):
    return None


@app.post("/shared/notes", status_code=201)
def share_note(title: str):
    return {"id": 2}


@app.get("/notes/{id}")
def read_note(id: int):
    return {"id": id}


@app.get("/notes/{id}/edit")
def edit_note(id: int):
    raise HTTPException(status_code=403, detail="read only")
