module Lapsable
  extend ActiveSupport::Concern

  def lapse!
    ActiveRecord::Base.connection.execute("UPDATE dim_account SET status = 'lapsed' WHERE id = $1")
  end
end
