# The loop takes each pair of the hash apart, so `name` is a key. suss
# reads the keys, sees the loop defines `label` and not `value`, and
# looks for `value` on the base class instead of stopping here.
class Types::R19DefineMethodHashType < Types::BaseObject
  field :value, String, null: false

  { label: "from define_method" }.each do |name, text|
    define_method(name) { text }
  end
end
