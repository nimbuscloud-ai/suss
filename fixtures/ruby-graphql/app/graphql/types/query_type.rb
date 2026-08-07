class Types::QueryType < Types::BaseObject
  field :campaign, resolver: Queries::CampaignQuery
end
