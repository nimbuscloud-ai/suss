# The class itself is written inside an `if`, one level down from where a
# reader of a file's own statement list would look for it.
if ENV["SCHEMA"] != "minimal"
  module Types
    class R09NestedModuleType < Types::BaseObject
      field :value, String, null: false
    end
  end
end
