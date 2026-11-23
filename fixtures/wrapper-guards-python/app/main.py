from fastapi import FastAPI

from app.notes import router

app = FastAPI()
app.include_router(router)
