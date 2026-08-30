# A repetitive schema gets written as a loop, and the block runs in the
# class body like anything else.
class Types::R05DoBlockType < Types::BaseObject
  [String].each do |type|
    field :value, type, null: false
  end
end
