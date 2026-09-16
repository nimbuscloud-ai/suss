// Two constructions of the one client, with different bases.

import { CatalogClient } from "./catalogClient";

export const storeCatalog = new CatalogClient("/store");
export const warehouseCatalog = new CatalogClient("/warehouse");
