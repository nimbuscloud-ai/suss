require "pg"

module Catalog
  def self.price_for(sku)
    conn = PG.connect(ENV["DATABASE_URL"])
    conn.exec_params(
      "UPDATE accounts SET last_priced_at = now() WHERE sku = $1",
      [sku]
    )
    10
  end
end
