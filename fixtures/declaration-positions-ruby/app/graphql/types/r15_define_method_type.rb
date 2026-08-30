# The field is declared plainly; the method behind it is defined in a
# loop. `define_method` takes the name at run time, so which methods this
# class ends up with is not something a reader of `def` nodes can say.
class Types::R15DefineMethodType < Types::BaseObject
  field :value, String, null: false

  %i[value].each do |name|
    define_method(name) { "from define_method" }
  end
end
