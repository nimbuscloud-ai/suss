from fastapi import FastAPI

from app.services import CreateInvoice, VoidInvoice

app = FastAPI()


@app.post("/invoices")
def create(amount: int):
    return CreateInvoice.call(amount=amount)


@app.post("/invoices/logged")
def create_logged(amount: int):
    return CreateInvoice.call_logged(amount=amount)


@app.post("/invoices/built")
def create_built(amount: int):
    return CreateInvoice.build(amount=amount).run()


@app.post("/invoices/later")
def create_later(amount: int):
    return CreateInvoice.perform_later(amount=amount)


@app.post("/invoices/{id}/void")
def void(id: int):
    return VoidInvoice.call(id=id)
