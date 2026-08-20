# The stores the code beside this file reaches, declared the way a
# deployment declares them. Invented fixture.

resource "google_storage_bucket" "uploads" {
  name     = "acme-uploads"
  location = "US"
}

resource "aws_s3_bucket" "archive" {
  bucket = "acme-archive"
}

# The cluster declares the Redis store and nothing about the key
# namespaces the code partitions it into, so nothing here pairs with
# the session cache's accesses.
resource "aws_elasticache_cluster" "sessions" {
  cluster_id = "sessions-v1"
  engine     = "redis"
  node_type  = "cache.t3.micro"
}
