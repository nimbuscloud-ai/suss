# A key-value store on the settings table. Callers pick the row by key,
# some with a key per user and some with one key for the whole site.

class Setting < ApplicationRecord
  def self.lookup(key)
    where(key: key).pick(:value)
  end

  def self.enabled?(key)
    lookup(key) == "on"
  end
end
