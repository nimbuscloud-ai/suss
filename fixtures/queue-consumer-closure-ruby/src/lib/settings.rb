# Required by both handlers. Each caller passes a variable its own
# function declares, so the read belongs to the call that passed the
# name, and neither function is charged with the other's variable.

module Settings
  def self.require_env(name)
    ENV.fetch(name)
  end
end
