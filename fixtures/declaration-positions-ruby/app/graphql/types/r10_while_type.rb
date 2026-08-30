class Types::R10WhileType < Types::BaseObject
  declared = false
  while declared == false
    field :value, String, null: false
    declared = true
  end
end
