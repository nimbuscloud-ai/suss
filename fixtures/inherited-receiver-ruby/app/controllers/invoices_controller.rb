class InvoicesController < ApplicationController
  def create
    Invoices::CreateService.call(amount: params[:amount])
    head :created
  end

  def create_logged
    Invoices::CreateService.call_logged(amount: params[:amount])
    head :created
  end

  def create_built
    Invoices::CreateService.build(amount: params[:amount]).call
    head :created
  end

  def create_later
    Invoices::CreateService.perform_later(amount: params[:amount])
    head :accepted
  end

  def void
    Invoices::VoidService.call(id: params[:id])
    head :ok
  end

  def retry_void
    Invoices::VoidService.new(id: params[:id]).retry_once
    head :ok
  end
end
