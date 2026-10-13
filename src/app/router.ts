// Client-side routes (the server answers every app path with index.html).
import { useEffect, useState } from "preact/hooks";

export type Route =
  | { name: "home" }
  | { name: "queue" }
  | { name: "inbox" }
  | { name: "subscriptions" }
  | { name: "episodes" }
  | { name: "history" }
  | { name: "favorites" }
  | { name: "statistics" }
  | { name: "add" }
  | { name: "settings" }
  | { name: "podcast"; id: string }
  | { name: "episode"; id: string }
  | { name: "not_found" };

export function parseRoute(path: string): Route {
  let parts: string[];
  try {
    parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return { name: "not_found" }; // an escape that is not UTF-8, such as %FF
  }
  if (parts.length === 0) return { name: "home" };
  const [head, id] = parts;
  if (parts.length === 2 && head === "podcast" && id) return { name: "podcast", id };
  if (parts.length === 2 && head === "episode" && id) return { name: "episode", id };
  if (parts.length === 1) {
    switch (head) {
      case "queue":
      case "inbox":
      case "subscriptions":
      case "episodes":
      case "history":
      case "favorites":
      case "statistics":
      case "add":
      case "settings":
        return { name: head };
    }
  }
  return { name: "not_found" };
}

export function pathOf(r: Route): string {
  switch (r.name) {
    case "home":
      return "/";
    case "podcast":
    case "episode":
      return `/${r.name}/${encodeURIComponent(r.id)}`;
    default:
      return `/${r.name}`;
  }
}

const listeners = new Set<() => void>();

export function navigate(path: string, replace = false): void {
  if (path === location.pathname + location.search) return;
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  for (const l of listeners) l();
  window.scrollTo(0, 0);
}

export function useRoute(): Route {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return parseRoute(path);
}

/** linkProps makes an anchor navigate inside the app (modifier clicks open new tabs as usual). */
export function linkProps(path: string) {
  return {
    href: path,
    onClick: (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(path);
    },
  };
}
