class Types::R07BeginRescueType < Types::BaseObject
  begin
    field :value, String, null: false
  rescue StandardError
    nil
  end
end
