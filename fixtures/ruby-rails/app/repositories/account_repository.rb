class AccountRepository
  def report
    close_lapsed
    tag_account(params_id, "premium")
    untiered_ids
    created_since(cutoff)
    total
    Account.stale_ids
  end

  def close_lapsed
    ActiveRecord::Base.connection.execute("UPDATE dim_account SET status = 'closed' WHERE closed_at < now()")
  end

  def tag_account(id, tier)
    ActiveRecord::Base.connection.exec_query(
      "UPDATE dim_account SET tier = $1 WHERE id = $2",
      "tag_account",
      [[nil, tier], [nil, id]]
    )
  end

  # Written from the model rather than from the base class. Both reach the
  # same connection.
  def untiered_ids
    Account.connection.select_values("SELECT id FROM dim_account WHERE tier IS NULL")
  end

  # The statement comes at the head of an array whose rest are the bind
  # values.
  def created_since(since)
    Account.find_by_sql(["SELECT * FROM dim_account WHERE created_at > ?", since])
  end

  def total
    Account.count_by_sql("SELECT count(*) FROM dim_account")
  end

  private

  def params_id
    1
  end

  def cutoff
    Time.now
  end
end
