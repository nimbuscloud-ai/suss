# The gateway checks the caller's token and passes the tenant it names in
# the X-Tenant-Id header, so the query takes the tenant from there and
# never from anything the caller wrote.
class OrdersController < ApplicationController
  def index
    render json: Order.where(tenant_id: request.headers["X-Tenant-Id"])
  end

  private

  def tenant_from(token)
    token.split(":").first
  end
end
