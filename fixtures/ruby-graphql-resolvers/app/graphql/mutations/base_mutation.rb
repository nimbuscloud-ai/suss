module Mutations
  class BaseMutation < GraphQL::Schema::RelayClassicMutation
    include RequiresSignIn

    object_class Types::BaseObject
  end
end
