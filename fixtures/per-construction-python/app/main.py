from fastapi import FastAPI

from app.models import Tag, Tool
from app.repos import AllRepositories, Repository

app = FastAPI()
session = None


@app.get("/tools/{key}")
def get_tool(key: int):
    return Repository(session, Tool).get_one(key)


@app.get("/tools-first")
def first_tool():
    return Repository(session, Tool).first()


@app.get("/tags/{key}")
def get_tag(key: int):
    return AllRepositories(session).tags.get_one(key)


@app.get("/factory-tools/{key}")
def get_factory_tool(key: int):
    return AllRepositories(session).tools.get_one(key)


def read_through(repo, key):
    return repo.get_one(key)


@app.get("/either/{key}")
def get_either(key: int):
    if key > 0:
        return read_through(Repository(session, Tool), key)
    return read_through(Repository(session, Tag), key)


@app.get("/only-tools/{key}")
def get_only_tools(key: int):
    return read_through(Repository(session, Tool), key)
