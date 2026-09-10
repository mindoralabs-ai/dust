# Mindora worker telemetry controls

Dust workers preserve their upstream telemetry behavior by default. The
Temporal runtime exports metrics to the in-cluster Datadog Agent OTLP endpoint,
and the worker command preloads `dd-trace/init` for tracing.

For a POC environment without that Datadog Agent endpoint, set:

```sh
TEMPORAL_DATADOG_METRICS_ENABLED=false
```

This removes only the Temporal OTLP metrics exporter. It does not disable the
worker logger or change authentication, model configuration, or the selected
worker groups.

The preloaded Datadog tracer already supports its own independent opt-out. To
start the POC workers without Datadog tracing, also set:

```sh
DD_TRACE_ENABLED=false
```

Set these through the deployment's environment or secret-aware configuration,
then run the existing bounded worker command. Neither variable changes which
workers the command starts.
