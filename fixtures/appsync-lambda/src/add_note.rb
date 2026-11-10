def handler(event:, context:)
  title = event["arguments"]["title"]
  raise ArgumentError, "title is required" if title.empty?

  { "id" => "2", "title" => title }
end
