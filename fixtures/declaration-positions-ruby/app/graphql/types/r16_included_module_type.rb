# The field is declared by the module's own `included` hook, against the
# class the hook is handed. suss reads a class's fields from the bodies
# that class runs, and this body runs somewhere else against an argument.
class Types::R16IncludedModuleType < Types::BaseObject
  include Concerns::Valuable
end
