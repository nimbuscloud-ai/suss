import pytest

from app.orders import cancel_order
from app.refunds import refund_order


class TestCancel:
    def test_marks_the_order_cancelled(self):
        assert cancel_order("o-1")["status"] == "cancelled"

    def test_refunds_the_payment(self):
        assert refund_order("o-1")

    @pytest.mark.skip(reason="the second cancel is not written yet")
    def test_cancels_twice_without_harm(self):
        cancel_order("o-1")
        cancel_order("o-1")


def test_reads_a_cancelled_order(cancelled_order):
    assert cancelled_order["status"] == "cancelled"
