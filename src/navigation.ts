import { useEffect, useState } from "react";

export type PageKey = "overview" | "passenger-flow" | "simulator" | "procedures" | "schedules" | "incidents" | "regulation" | "power" | "scada" | "buses" | "rolling-stock" | "log" | "report" | "detail";
export type DetailType = "train" | "circuit" | "driver" | "incident" | "power";

export interface AppRoute {
  page: PageKey;
  detailType?: DetailType;
  id?: string;
  nativeIncidentId?: string;
  procedureId?: string;
}

const PAGE_PATHS: Record<Exclude<PageKey, "detail">, string> = {
  overview: "/overview",
  "passenger-flow": "/passenger-flow",
  simulator: "/simulator",
  procedures: "/procedures",
  schedules: "/schedules-drivers",
  incidents: "/incidents",
  regulation: "/regulation",
  power: "/power",
  scada: "/scada",
  buses: "/bus-services",
  "rolling-stock": "/rolling-stock",
  log: "/operations-log",
  report: "/shift-report",
};

export function pathForPage(page: Exclude<PageKey, "detail">): string {
  return PAGE_PATHS[page];
}

export function detailPath(type: DetailType, id: string): string {
  return `/details/${type}/${encodeURIComponent(id)}`;
}

export function nativeIncidentPath(id: string): string {
  return `/overview/incident/${encodeURIComponent(id)}`;
}

export function procedurePath(id: string): string {
  return `/procedures/${encodeURIComponent(id)}`;
}

export function navigate(path: string): void {
  if (window.location.hash === `#${path}`) return;
  window.location.hash = path;
}

export function parseHash(hash: string): AppRoute {
  const path = hash.replace(/^#/, "") || "/overview";
  const procedure = path.match(/^\/procedures\/([^/]+)$/);
  if (procedure) {
    try {
      return { page: "procedures", procedureId: decodeURIComponent(procedure[1]) };
    } catch {
      return { page: "procedures" };
    }
  }
  const nativeIncident = path.match(/^\/overview\/incident\/([^/]+)$/);
  if (nativeIncident) {
    try {
      return { page: "overview", nativeIncidentId: decodeURIComponent(nativeIncident[1]) };
    } catch {
      return { page: "overview" };
    }
  }
  const detail = path.match(/^\/details\/(train|circuit|driver|incident|power)\/([^/]+)$/);
  if (detail) {
    try {
      return {
        page: "detail",
        detailType: detail[1] as DetailType,
        id: decodeURIComponent(detail[2]),
      };
    } catch {
      return { page: "overview" };
    }
  }
  const match = Object.entries(PAGE_PATHS).find(([, routePath]) => routePath === path);
  return match ? { page: match[0] as Exclude<PageKey, "detail"> } : { page: "overview" };
}

export function useHashRoute(): AppRoute {
  const [route, setRoute] = useState<AppRoute>(() => parseHash(window.location.hash));

  useEffect(() => {
    const syncRoute = () => {
      const next = parseHash(window.location.hash);
      if (
        next.page === "overview" &&
        !next.nativeIncidentId &&
        window.location.hash !== "#/overview"
      ) {
        window.history.replaceState(
          null,
          document.title,
          `${window.location.pathname}${window.location.search}#/overview`,
        );
      }
      setRoute(next);
    };
    syncRoute();
    const onHashChange = () => syncRoute();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return route;
}
