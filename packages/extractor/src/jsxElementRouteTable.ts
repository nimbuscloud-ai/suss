/**
 * The `jsxElementRoute` discovery member, read as a route table. The
 * member says which element is a route, which of its attributes give the
 * path, the element and the index, and which factories take route
 * objects. Each of those maps onto a table with one `serves` role, so a
 * pack that still writes the member gets the reading a pack that
 * declares the table gets. The sentences an unread entry is reported
 * with are here for the same reason, and any table of JSX route
 * elements and route objects can use them as they are.
 */

import type { DiscoveryMatch, RouteTableMatch } from "./framework.js";
import type { ChildrenIn, RouteUnread, ServesRole } from "./routeTable.js";

type JsxElementRouteMatch = Extract<
  DiscoveryMatch,
  { type: "jsxElementRoute" }
>;

/** Why a JSX route element or a route object claims no route, said to whoever reads the unit. */
export const JSX_ROUTE_UNREAD: Readonly<Record<RouteUnread, string>> = {
  pathUnread:
    "The path this route declares is not written as a string literal, so no path is claimed and this route pairs with nothing",
  prefixUnread:
    "A route this one is nested under declares its path as something other than a string literal, so the full path is not claimed and this route pairs with nothing",
  spread:
    "A spread stands in for routes declared elsewhere in this array, and they are not read here, so no path is claimed for any of them",
  notAnEntry:
    "This route is built by a call rather than written out where the router is created, so nothing of it is read and no path is claimed",
  rootListUnread:
    "The routes this router is created from are not written as an array literal within reach, so none of them are read here",
  listUnread:
    "The routes nested under this one are not written as an array literal within reach, so none of them are read here",
};

/**
 * The route table a `jsxElementRoute` match describes: the route element
 * as the one role, read from an element's attributes or an object's keys,
 * nested through the elements written inside it and its children list,
 * with every element no other encloses and every factory call in the
 * file as a root.
 */
export function jsxElementRouteTable(
  match: JsxElementRouteMatch,
): RouteTableMatch {
  const listed: ChildrenIn[] =
    match.childrenAttribute === undefined
      ? []
      : [{ in: "list", pick: { key: match.childrenAttribute } }];
  const route: ServesRole = {
    role: "serves",
    methods: [match.method],
    path: [{ key: match.pathAttribute }],
    ...(match.indexAttribute === undefined
      ? {}
      : { index: { key: match.indexAttribute } }),
    handler: { value: [{ key: match.elementAttribute }] },
    children: [{ in: "elements" }, ...listed],
  };
  return {
    type: "routeTable",
    table: {
      roots: {
        kinds: Object.fromEntries(
          (match.routeObjectFactories ?? []).map((name) => [name, 0]),
        ),
        children: { in: "list", pick: { at: 0 } },
        in: "file",
        elements: true,
      },
      roles: { [match.routeElement]: route },
      objects: match.routeElement,
      from:
        typeof match.importModule === "string"
          ? [match.importModule]
          : match.importModule,
      absolutePaths: "standAlone",
      elementLists: match.elementsFactories ?? [],
      loops: [],
    },
    through: "element",
    unread: JSX_ROUTE_UNREAD,
  };
}
