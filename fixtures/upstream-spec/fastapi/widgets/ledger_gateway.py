"""Records sales with the ledger service through the client generated from
openapi/ledger.json. The request is built inside the generated package, so
nothing here says which path or verb it calls.
"""

import ledger_client
from ledger_client.api.accounts_api import AccountsApi


class LedgerGateway:
    def __init__(self):
        self._accounts = AccountsApi(ledger_client.ApiClient(ledger_client.Configuration()))

    def record_sale(self, account_id, amount_cents):
        return self._accounts.create_entry(
            account_id,
            create_entry_request=ledger_client.CreateEntryRequest(amount_cents=amount_cents),
        )

    def account(self, account_id):
        return self._accounts.get_account(account_id)
