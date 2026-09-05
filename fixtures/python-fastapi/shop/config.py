"""Settings the process reads from its environment when it starts.

Neither field has a default, so the route path and the mount prefix
that read them are known only at run time.
"""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    report_path: str
    admin_prefix: str


settings = Settings()
