class EventsController < ApplicationController
  def via_send
    EventHandlers.new(params[:payload]).consume(params[:kind])
    head :ok
  end

  def via_literal_send
    EventHandlers.new(params[:payload]).consume_literal
    head :ok
  end

  def via_finish
    EventHandlers.new(params[:payload]).finish(params[:kind])
    head :ok
  end

  def via_public_send
    EventHandlers.new(params[:payload]).consume_public(params[:kind])
    head :ok
  end

  def via_table
    EventHandlers::HANDLERS[params[:kind].to_sym].call(params[:payload])
    head :ok
  end

  def via_method_table
    EventHandlers.method_table[params[:kind].to_sym].call(params[:payload])
    head :ok
  end

  def via_block
    EventHandlers.run_later(params[:payload]) { |payload| EventHandlers.on_created(payload) }
    head :ok
  end

  def via_proc
    EventHandlers.run_proc(params[:payload], ->(payload) { EventHandlers.on_deleted(payload) })
    head :ok
  end
end
