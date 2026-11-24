# A finding and a non-finding

The same candidate, judged twice.

## Kept: a finding
The candidate: `applyDiscount` divides by `quantity`, and `quantity` can be 0.

- Reachable: `metator graph callers applyDiscount` → `src/cart.ts:41` → `POST /cart/items`, the handler a client calls.
- Trigger: a cart line added with `{"quantity": 0}`; the request schema allows `minimum: 0`.
- Severity: blocking. A wrong result (`Infinity` in the total) on a reachable path.
- Evidence: a test that adds a line with quantity 0 and expects 0, red today.
- Quote: `const unit = line.total / line.quantity;` (src/price.ts:18), found verbatim by `metator findings validate`.

## Dropped: not a finding
The candidate: `formatPrice` does not handle a negative amount.

- Reachable: its callers (`metator graph callers formatPrice`) pass only `Math.abs(...)` results, so no negative amount reaches it.
- Trigger: none can be named from a real input.
- Outcome: no finding. If the contract should allow negatives, it is a question for the author, written as a question, without a severity.

## Kept as minor
The candidate: a new adapter throws `new Error("timeout")`.

- Reachable: yes, on every timeout.
- Severity: minor, with its rule: MT-CODE-001 (errors are values). Without the rule id it would be taste and dropped.
