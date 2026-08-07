class Mutations::CampaignUpdate < Mutations::BaseMutation
  argument :campaign_id, ID, required: true
  argument :name, String, required: false

  field :campaign, Types::CampaignType, null: true
  field :errors, [String], null: false

  def resolve(campaign_id:, name: nil)
    campaign = Campaign.find(campaign_id)
    campaign.update(name: name) if name
    { campaign: campaign, errors: [] }
  end
end
