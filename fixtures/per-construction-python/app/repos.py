from functools import cached_property

from sqlalchemy import select

from app.models import Tag, Tool


class Repository[Model]:
    def __init__(self, session, sql_model: type[Model]):
        self.session = session
        self.model = sql_model

    def get_one(self, key):
        return self.session.execute(select(self.model).filter_by(id=key)).scalar_one()

    def first(self):
        return self.get_one(1)


class TagRepository(Repository[Tag]):
    def __init__(self, session):
        super().__init__(session, Tag)


class AllRepositories:
    def __init__(self, session):
        self.session = session

    @cached_property
    def tools(self):
        return Repository(self.session, Tool)

    @cached_property
    def tags(self):
        return TagRepository(self.session)
