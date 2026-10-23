# Runs in ReportsFunction on a timer. The template points at the class
# method with its namespace, `Reports::Nightly.run`.

module Reports
  class Nightly
    def self.run(event:, context:)
      { generated: event.fetch("time", "unknown") }
    end
  end
end
