# Runs in AccountsFunction behind an HTTP route. Nothing here reads the
# queue, so its call is not the worker's to repeat.

def create_account(body)
  Faraday.post("https://accounts.example.internal/v1/accounts", body)
end

def handler(event:, context:)
  create_account(event["body"])
  { statusCode: 201 }
end
