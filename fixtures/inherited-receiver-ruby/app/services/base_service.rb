# Every service is called on its own class, `Invoices::CreateService.call`,
# and runs the class methods written here with `self` set to that class.
class BaseService
  def self.call(...)
    new(...).call
  end

  def self.call_logged(**args)
    service = new(**args)
    service.call_with_log
  end

  def self.build(**args)
    new(**args)
  end

  def self.call_built(**args)
    build(**args).call
  end

  def self.perform_later(**args)
    perform(**args)
  end

  def initialize(**args)
    @args = args
  end

  def call
    raise NotImplementedError
  end

  def call_with_log
    log_start
    call
  end

  def retry_once
    self.class.call(**@args)
  end

  def log_start; end
end
