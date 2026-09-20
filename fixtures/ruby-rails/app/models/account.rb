class Account < ApplicationRecord
  # A bare `connection` inside the model. Ruby sends it to the class, and
  # the class reaches ActiveRecord::Base through ApplicationRecord.
  def self.stale_ids
    connection.select_values("SELECT id FROM dim_account WHERE updated_at < now()")
  end
end
