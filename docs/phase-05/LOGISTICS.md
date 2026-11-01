# Logistics

The logistics boundary is provider-neutral. Manual booking is available with an
external reference, tracking number, quote/cost, evidence, and audit context.
GIG and Fez adapters deliberately report unavailable until their contracts and
credentials are verified; the system never fabricates provider requests.

## Development simulation

Until Hook has registered with an external logistics provider, local QA may use
the explicit simulator by starting the API with:

```text
NODE_ENV=development LOGISTICS_SIMULATION_ENABLED=true npm run start
```

The Admin shipment workspace then exposes `Simulation (development only)`. It
creates a clearly tagged `simulated` shipment with synthetic references and
tracking data, and existing audited status-transition controls can advance it
through the fulfilment lifecycle. The backend rejects `simulated` bookings in
production regardless of any client payload. The simulator never calls GIG or
Fez and must not be used as evidence that those provider integrations are live.

Booking leaves an Order `READY_FOR_DISPATCH`. Pickup or transit moves it to
`IN_TRANSIT`.
