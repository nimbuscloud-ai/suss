// A client class given its base path when it is made, whose ten methods
// all send their request through one that builds the URL.

import { http } from "./http";

export class CatalogClient {
  constructor(private readonly baseUrl: string) {}

  private request(endpoint: string) {
    return http.get(`${this.baseUrl}/${endpoint}`);
  }

  listProducts() {
    return this.request("products");
  }

  listCategories() {
    return this.request("categories");
  }

  listBrands() {
    return this.request("brands");
  }

  listCollections() {
    return this.request("collections");
  }

  listReviews() {
    return this.request("reviews");
  }

  listVariants() {
    return this.request("variants");
  }

  listPrices() {
    return this.request("prices");
  }

  listStock() {
    return this.request("stock");
  }

  listTags() {
    return this.request("tags");
  }

  listBundles() {
    return this.request("bundles");
  }
}
