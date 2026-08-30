class Types::R06BraceBlockType < Types::BaseObject
  [String].each { |type| field :value, type, null: false }
end
