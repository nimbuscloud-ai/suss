class Queries::CampaignQuery < Queries::BaseQuery
  argument :campaign_id, ID, required: true

  type Types::CampaignType, null: true

  def resolve(campaign_id:)
    Campaign.find(campaign_id)
  end
end
