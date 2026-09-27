class Types::ListingType < Types::BaseObject
  field :id, ID, null: false
  field :title, String, null: false
  field :short_desc, String, null: true
end
