module Concerns::Contactable
  def phone
    object.phone_number&.formatted
  end
end
