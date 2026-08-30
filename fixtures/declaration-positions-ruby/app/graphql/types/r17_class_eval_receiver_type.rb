# `class_eval` with a receiver reopens whatever that expression evaluates
# to. The declaration is written outside any class body, so which class
# owns it is a question about the receiver rather than about placement.
class Types::R17ClassEvalReceiverType < Types::BaseObject
end

Types::R17ClassEvalReceiverType.class_eval do
  field :value, String, null: false
end
