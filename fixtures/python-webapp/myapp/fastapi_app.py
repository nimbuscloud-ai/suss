"""A FastAPI-style route file, for the annotation-reading side of the
Python adapter's v0 slice: parameter annotations, a return annotation,
and a response model class read as a declared shape. Read through an
inline pack config in the flask-restx package's extraction test; the
shipped FastAPI pack (@suss/framework-fastapi) has its own fixture.
"""

from typing import Optional

from fastapi import FastAPI

app = FastAPI()


class TodoResponse:
    """Shaped like a Pydantic model without depending on pydantic: an
    annotated class body is exactly what the adapter reads either way.
    """

    id: int
    title: str
    done: bool = False


@app.get("/items/{item_id}", response_model=TodoResponse)
def read_item(item_id: int, q: Optional[str] = None):
    pass


@app.post("/items", status_code=201, response_model=TodoResponse)
def create_item(payload: TodoResponse):
    pass
