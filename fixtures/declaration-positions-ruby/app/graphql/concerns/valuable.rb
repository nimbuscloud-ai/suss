module Concerns::Valuable
  def self.included(base)
    base.field :value, String, null: false
  end
end
