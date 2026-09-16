# Two constructions of the one client, with different bases.

from catalog_client import CatalogClient

store_catalog = CatalogClient("/store")
warehouse_catalog = CatalogClient("/warehouse")
