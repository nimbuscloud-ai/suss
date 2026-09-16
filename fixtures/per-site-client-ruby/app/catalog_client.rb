# A client class given its base path when it is made, whose ten methods
# all send their request through one that builds the URL.

class CatalogClient
  def initialize(base_url)
    @base_url = base_url
  end

  def request(endpoint)
    Faraday.get("#{@base_url}/#{endpoint}")
  end

  def list_products
    request("products")
  end

  def list_categories
    request("categories")
  end

  def list_brands
    request("brands")
  end

  def list_collections
    request("collections")
  end

  def list_reviews
    request("reviews")
  end

  def list_variants
    request("variants")
  end

  def list_prices
    request("prices")
  end

  def list_stock
    request("stock")
  end

  def list_tags
    request("tags")
  end

  def list_bundles
    request("bundles")
  end
end
