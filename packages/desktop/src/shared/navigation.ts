/**
 * Where the app goes (ADR-0109): the one place that writes the hash route, so a component never
 * writes to `window.location` itself.
 */
import { type Route, routeHash } from "./model/route.ts";

/** Goes to a place of the app: the router reads the new hash and shows it. */
export function navigate(route: Route): void {
  window.location.hash = routeHash(route);
}
