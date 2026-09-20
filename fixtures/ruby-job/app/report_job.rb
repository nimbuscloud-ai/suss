class ReportJob
  def initialize(settings)
    @settings = settings
  end

  def run
    ActiveRecord::Base.connection.execute("UPDATE dim_account SET status = 'open' WHERE status IS NULL")
  end

  def self.run_nightly
    ActiveRecord::Base.connection.exec_query("SELECT id FROM dim_account WHERE tier IS NULL")
  end
end
