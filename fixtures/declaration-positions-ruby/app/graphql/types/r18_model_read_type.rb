# The method behind a field can be written inside an `if` too, and without
# it the field reads as having no method and the database call it makes is
# missing from the summary.
class Types::R18ModelReadType < Types::BaseObject
  field :value, String, null: false

  if ENV["FEATURE_VALUE"] == "on"
    def value
      Campaign.find(1).name
    end
  end
end
