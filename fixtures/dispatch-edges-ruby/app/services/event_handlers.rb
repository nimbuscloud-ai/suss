class EventHandlers
  SUPPORTED = [:created, :deleted].freeze

  HANDLERS = {
    created: ->(payload) { EventHandlers.on_created(payload) },
    deleted: proc { |payload| EventHandlers.on_deleted(payload) },
  }.freeze

  def self.on_created(payload)
    payload.size
  end

  def self.on_deleted(payload)
    payload.size + 1
  end

  def self.on_archived(payload)
    payload.size + 2
  end

  def self.method_table
    { archived: method(:on_archived) }
  end

  def self.run_later(payload)
    yield payload
  end

  def self.run_proc(payload, task)
    task.call(payload)
  end

  def initialize(payload)
    @payload = payload
  end

  def consume(kind)
    send(kind)
  end

  def consume_public(kind)
    public_send(kind)
  end

  def consume_literal
    send(:created)
  end

  def created
    EventHandlers.on_created(@payload)
  end

  def deleted
    EventHandlers.on_deleted(@payload)
  end
end
