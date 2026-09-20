class Order < ApplicationRecord
  before_save :normalize_reference
  after_commit :sync_search_index, on: :create
  after_destroy :drop_search_index

  def normalize_reference
    self.reference = reference.to_s.strip
  end

  def sync_search_index
    Account.count_by_sql("SELECT count(*) FROM dim_account")
  end

  def drop_search_index
    Account.connection.execute("DELETE FROM dim_search WHERE order_id = $1")
  end
end
