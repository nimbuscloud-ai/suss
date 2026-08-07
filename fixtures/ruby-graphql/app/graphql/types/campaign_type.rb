class Types::CampaignType < Types::BaseObject
  field :id, ID, null: false
  field :name, String, null: true
  field :budget, Float, null: true
end
