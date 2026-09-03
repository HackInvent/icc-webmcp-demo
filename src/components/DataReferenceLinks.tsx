import type { PageKey } from "../navigation";
import { Icon } from "./Icon";

export const WIKIPEDIA_NETWORK_REFERENCE_URL =
  "https://fr.wikipedia.org/wiki/Transports_en_commun_en_%C3%8Ele-de-France";

export const RATP_SVG_REFERENCE_URL = "https://www.ratp.fr/plan-metro";

const NATIVE_SVG_PAGES = new Set<PageKey>(["overview", "passenger-flow"]);

export function pageUsesNativeNetworkSvg(page: PageKey): boolean {
  return NATIVE_SVG_PAGES.has(page);
}

interface DataReferenceLinksProps {
  page: PageKey;
}

export function DataReferenceLinks({ page }: DataReferenceLinksProps) {
  const includesSvgReference = pageUsesNativeNetworkSvg(page);
  return (
    <aside
      className="data-reference-links"
      id="text-text-view-data-references"
      data-testid="view-data-references"
      data-page={page}
      aria-label="Public data references"
      title="Public reference links. Runtime and operational provenance remain identified separately in the application."
    >
      <span>Public references</span>
      <a
        data-testid="wikipedia-network-reference"
        href={WIKIPEDIA_NETWORK_REFERENCE_URL}
        target="_blank"
        rel="noreferrer"
      >
        <Icon name="external" size={12} />
        Wikipedia · Île-de-France network
      </a>
      {includesSvgReference && (
        <a
          data-testid="ratp-svg-reference"
          href={RATP_SVG_REFERENCE_URL}
          target="_blank"
          rel="noreferrer"
        >
          <Icon name="external" size={12} />
          Map adapted from the public RATP network map · © RATP
        </a>
      )}
    </aside>
  );
}
