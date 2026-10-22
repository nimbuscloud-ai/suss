# Each element is a pair the block takes apart, and `at` is its
# position. suss reads the names the loop defines, `value` among them, so
# the field stops at the define_method as it does in r15.
class Types::R20DefineMethodPairsType < Types::BaseObject
  field :value, String, null: false

  [[:value, "first"], [:label, "second"]].each_with_index do |(name, text), at|
    define_method(name) { "#{text} #{at}" }
  end
end
