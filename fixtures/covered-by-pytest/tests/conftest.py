import pytest

from app.orders import cancel_order


@pytest.fixture
def cancelled_order():
    return cancel_order("o-1")
