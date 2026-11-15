require_relative "../lib/importer"

ImportJob.perform_async("nightly")
