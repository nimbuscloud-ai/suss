module Admin
  class AuditsController < ApplicationController
    include Audited
    include Pagination

    def index
      record_audit
      page_size
    end
  end
end
