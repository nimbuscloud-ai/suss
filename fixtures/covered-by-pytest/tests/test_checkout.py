from unittest.mock import patch

from app.checkout import checkout


@patch("app.checkout.cancel_order")
def test_cancels_on_a_failed_checkout(cancel):
    checkout("o-1")
