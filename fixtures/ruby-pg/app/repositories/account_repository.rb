require "pg"

class AccountRepository
  def initialize
    @conn = PG.connect(ENV["DATABASE_URL"])
  end

  def find(id)
    @conn.exec_params("SELECT id, name, tier FROM accounts WHERE id = $1", [id])
  end

  def rename(id, name)
    @conn.exec_params("UPDATE accounts SET name = $2 WHERE id = $1", [id, name])
  end

  def suspend_all
    @conn.exec("UPDATE accounts SET suspended_at = now()")
  end

  def start
    @conn.exec("BEGIN")
  end

  def prepare_lookup
    @conn.prepare("by_email", "SELECT id FROM accounts WHERE email = $1")
  end

  def with_plans
    @conn.async_exec(
      "SELECT a.id, p.name FROM accounts a JOIN plans p ON p.id = a.plan_id"
    )
  end

  def run(sql)
    @conn.exec(sql)
  end
end
