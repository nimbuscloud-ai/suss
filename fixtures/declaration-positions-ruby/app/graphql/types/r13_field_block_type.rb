# A block on a `field` call configures that field. The `argument` in it
# belongs to `value`, not to the class, so widening the walk must not
# hoist it into the class body.
class Types::R13FieldBlockType < Types::BaseObject
  field :value, String, null: false do
    argument :locale, String, required: false
  end
end
