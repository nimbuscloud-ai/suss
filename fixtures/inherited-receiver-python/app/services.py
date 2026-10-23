# Every service is called on its own class, `CreateInvoice.call(...)`, and
# runs the classmethods written here with `cls` set to that class.

from sqlmodel import Field, Session, SQLModel


class Invoice(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    amount: int
    status: str = "open"


class AuditEntry(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    action: str


def get_session() -> Session:
    return Session()


class BaseService:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

    @classmethod
    def call(cls, **kwargs):
        return cls(**kwargs).run()

    @classmethod
    def call_logged(cls, **kwargs):
        service = cls(**kwargs)
        return service.run_with_log()

    @classmethod
    def build(cls, **kwargs):
        return cls(**kwargs)

    @classmethod
    def call_built(cls, **kwargs):
        return cls.build(**kwargs).run()

    @classmethod
    def perform_later(cls, **kwargs):
        return cls.perform(**kwargs)

    @staticmethod
    def label(amount):
        return f"invoice for {amount}"

    def run(self):
        raise NotImplementedError

    def run_with_log(self):
        self.log_start()
        return self.run()

    def log_start(self):
        return None


class CreateInvoice(BaseService):
    @classmethod
    def perform(cls, **kwargs):
        session = get_session()
        session.add(AuditEntry(action="invoice.create"))

    def run(self):
        session = get_session()
        session.add(Invoice(amount=self.kwargs["amount"]))
        session.commit()


class VoidInvoice(BaseService):
    def run(self):
        session = get_session()
        invoice = session.get(Invoice, self.kwargs["id"])
        invoice.status = "voided"
        session.add(invoice)
        session.commit()
