module RequiresSignIn
  def ready?(**args)
    raise GraphQL::ExecutionError, "Sign in first" unless context[:current_user]

    super
  end
end
