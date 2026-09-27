class Types::QueryType < Types::BaseObject
  field :listing, Types::ListingType, null: true do
    argument :id, ID, required: true
  end

  def listing(id:)
    Listing.find(id)
  end
end
