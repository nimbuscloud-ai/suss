class Cli
  COMMANDS = {
    check: ->(args) { Cli.run_check(args) },
    init: method(:run_init),
  }.freeze

  def self.run(argv)
    COMMANDS.fetch(argv.first.to_sym).call(argv.drop(1))
  end

  def self.run_check(args)
    return 1 if args.include?("--fail")

    0
  end

  def self.run_init(args)
    return 0 if args.include?("--plain")

    2
  end
end

exit(Cli.run(ARGV))
