# The field name comes from the loop variable, so no reader of this file
# can say what the schema ends up calling it. suss names the declaration
# by the expression it was written as and binds it to nothing.
class Types::R14ComputedNameType < Types::BaseObject
  %i[value].each do |name|
    field name, String, null: false
  end
end
