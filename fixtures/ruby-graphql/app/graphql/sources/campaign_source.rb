class Sources::CampaignSource < GraphQL::Dataloader::Source
  def initialize(model)
    @model = model
  end

  def fetch(ids)
    active_ids(ids)
  end

  private

  def active_ids(ids)
    Campaign.where(id: ids, state: "active")
  end
end
