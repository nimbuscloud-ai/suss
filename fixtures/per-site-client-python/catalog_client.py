# A client class given its base path when it is made, whose ten methods
# all send their request through one that builds the URL.

import requests


class CatalogClient:
    def __init__(self, base_url):
        self.base_url = base_url

    def request(self, endpoint):
        return requests.get(f"{self.base_url}/{endpoint}")

    def list_products(self):
        return self.request("products")

    def list_categories(self):
        return self.request("categories")

    def list_brands(self):
        return self.request("brands")

    def list_collections(self):
        return self.request("collections")

    def list_reviews(self):
        return self.request("reviews")

    def list_variants(self):
        return self.request("variants")

    def list_prices(self):
        return self.request("prices")

    def list_stock(self):
        return self.request("stock")

    def list_tags(self):
        return self.request("tags")

    def list_bundles(self):
        return self.request("bundles")
