---
"evlog": minor
---

Add the Sazabi drain adapter (`evlog/sazabi`). It sends wide events to a Sazabi log stream over OTLP/HTTP, reusing the OTLP adapter's encoding. The stream's intake URL carries its key, so configuration is one variable: `SAZABI_INTAKE_URL` (optional `SAZABI_SERVICE_NAME`, falling back to `OTEL_SERVICE_NAME`). `createSazabiDrain()` also accepts `endpoint`, `serviceName`, `resourceAttributes`, `timeout` and `retries`, and an intake URL pasted with its `/v1/logs` suffix is used as is. Records use the compact OTLP shape by default (a one-line summary body and dotted attributes); `recordShape: 'json'` sends the serialized event instead. `sendToSazabi` and `sendBatchToSazabi` send events directly.
