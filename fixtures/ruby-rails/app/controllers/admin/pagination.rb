# A controller inside `module Admin` that includes `Pagination` gets this
# one, because Ruby tries the enclosing namespace before the top level.
module Admin
  module Pagination
    def page_size
      OrderService.new.summarize(params[:id])
    end
  end
end
