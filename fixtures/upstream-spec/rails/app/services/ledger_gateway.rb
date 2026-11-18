# Records sales with the ledger service through the client generated from
# openapi/ledger.json. The request is built inside the generated gem, so
# nothing here says which path or verb it calls.
class LedgerGateway
  class Unavailable < StandardError; end

  def record_sale(account_id, amount_cents)
    call do
      accounts_api.create_entry(account_id, create_entry_request: LedgerClient::CreateEntryRequest.new(amount_cents: amount_cents))
    end
  end

  def account(account_id)
    call { accounts_api.get_account(account_id) }
  end

  private

  def accounts_api
    @accounts_api ||= LedgerClient::AccountsApi.new(api_client)
  end

  def api_client
    @api_client ||= LedgerClient::ApiClient.new(LedgerClient::Configuration.new)
  end

  def call
    yield
  rescue LedgerClient::ApiError => e
    raise Unavailable, e.message
  end
end
