# Performance and scaling

## Upstream budgets

New Relic enforces a maximum of 25 concurrent NerdGraph requests per user across
all keys owned by that user. The server therefore defaults to a 20-request global
semaphore, leaving headroom for `doctor`, the New Relic UI, Terraform, and other
integrations. Complex NRQL additionally uses a five-request semaphore.

Both semaphores also bound their pending queues to 50 waiters per permit. Excess
load fails locally as rate-limited instead of retaining unbounded promises; caller
cancellation removes queued work immediately.

The budget is per New Relic user, not per key, process, pod, account, or region.
Creating another key for the same user does not create another 25-request budget.

## Multiple replicas

The Helm chart defaults to one replica and `Recreate` updates to prevent a rollout
from temporarily doubling upstream concurrency. If `R` replicas share the same
New Relic user, set each replica's total concurrency no higher than:

```text
floor(shared_budget / R)
```

For the default conservative shared budget of 20:

| Replicas | Max total concurrency per replica | Suggested NRQL concurrency |
| -------: | --------------------------------: | -------------------------: |
|        1 |                                20 |                          5 |
|        2 |                                10 |                          2 |
|        3 |                                 6 |                        1–2 |
|        4 |                                 5 |                          1 |

Also budget for non-MCP consumers using that user. Horizontal autoscaling cannot
automatically recompute this value, so HPA is disabled. Before enabling it, use
separately budgeted New Relic users or choose a per-pod limit safe at `maxReplicas`.

### Cancellation routing

The official MCP SDK sends cancellation as a separate
`notifications/cancelled` HTTP POST. The server's authenticated in-flight registry
is bounded and process-local; it is not a distributed session or cancellation
store. The default single replica therefore provides deterministic cancellation.
With more than one replica, ordinary calls remain stateless, but prompt
cross-request cancellation requires the original POST and cancellation POST to
reach the same replica. Without that routing guarantee, cancellation is
best-effort and work can continue until the configured server deadline.

The safest strict-cancellation configuration is `replicaCount: 1`. If multiple
replicas are required, configure deterministic affinity using a stable,
authenticated routing key at the trusted proxy. Never trust a client-supplied
identity header unless the proxy removes it and derives a replacement only after
validating the token. For ingress-nginx, hashing the unchanged Authorization value
is a practical fallback while the same token is used for both POSTs:

```yaml
ingress:
  annotations:
    nginx.ingress.kubernetes.io/upstream-hash-by: '$http_authorization'
```

Keep TLS enabled and ensure proxy logs never include the Authorization header.
Token refresh can change this hash; a shared static bearer token also sends all of
that token's traffic to one replica. Prefer a stable identity derived by a trusted
OIDC-aware proxy when both strict cancellation and useful distribution are
required. Verify the behavior of the selected ingress implementation; the example
above is specific to
[ingress-nginx custom upstream hashing](https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/annotations/#custom-nginx-upstream-hashing).

## Latency

Most wall time is NerdGraph latency. With a zero-latency mock upstream, the p95
server overhead target is below 100 ms. Keep these paths efficient:

- persistent HTTPS connections and DNS caching at the runtime/network layer;
- no response-body logging or high-cardinality metrics;
- Zod parsing once at each boundary;
- bounded stable JSON serialization;
- small TTL caching only for safe metadata;
- same-replica cancellation propagated to queued and active requests.

Do not raise concurrency to hide a slow NRQL query. Narrow its time window, select
only required attributes, filter early, remove high-cardinality facets, and use
New Relic's asynchronous query workflow when appropriate.

## Response and context size

The 1 MiB result limit is a transport safety ceiling, not a target. AI client context
windows and tool-output limits are often much smaller. Prefer summaries, a limited
page size, cursors, and targeted attributes. The server flags truncation; callers
must not assume truncated aggregates or entity sets are complete.

NRQL normal results are capped at New Relic's documented 5,000 maximum. Entity
search is capped at 200 per page. Other lists default to 100 and follow cursors.

## Cache behavior

The optional in-memory cache is per process. It is useful for account/capability
and small configuration reads, but it does not coordinate between replicas. It
must never cache NRQL results, secrets, mutation errors, secure values, presigned
URLs, or authorization decisions. A low TTL reduces upstream calls without hiding
configuration changes for long.

Set `NEW_RELIC_CACHE_TTL_MS=0` when strict read-after-write behavior across replicas
matters more than upstream load. Mutation tools invalidate all local entries
and perform an uncached readback.

## Load testing

`npm run test:load` uses a local mock NerdGraph endpoint to verify:

- observed upstream concurrency never exceeds configured semaphores;
- NRQL has its independent ceiling;
- p95 proxy overhead remains below 100 ms with zero-latency upstream;
- memory reaches a stable plateau over at least 10,000 calls;

Unit, contract, and security suites separately verify queued cancellation, bounded
jittered 429 retries, and oversized-response rejection/truncation.

Never run load tests against a production New Relic user or account.
