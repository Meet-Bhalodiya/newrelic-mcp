export const NEW_RELIC_REGIONS = ['US', 'EU', 'JP'] as const;

export type NewRelicRegion = (typeof NEW_RELIC_REGIONS)[number];

/** Fixed NerdGraph query/configuration endpoints; see the source-matrix evidence note for JP. */
export const NERDGRAPH_ENDPOINTS: Readonly<Record<NewRelicRegion, string>> = {
  US: 'https://api.newrelic.com/graphql',
  EU: 'https://api.eu.newrelic.com/graphql',
  JP: 'https://api.jp.newrelic.com/graphql',
};

export function nerdGraphEndpoint(region: NewRelicRegion): string {
  return NERDGRAPH_ENDPOINTS[region];
}
