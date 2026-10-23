class Talk < ApplicationRecord
  belongs_to :event
  has_many :reviews
end
