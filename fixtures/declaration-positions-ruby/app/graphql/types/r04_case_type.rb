class Types::R04CaseType < Types::BaseObject
  case ENV.fetch("TIER", "free")
  when "paid"
    field :value, String, null: false
  end
end
