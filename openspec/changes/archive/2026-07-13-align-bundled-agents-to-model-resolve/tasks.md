## 1. Spec alignment

- [x] 1.1 Rewrite the `bundled-agents` requirement "The bundled Explore agent SHALL use a role alias for its model" body to reference the `model:resolve` event and a registered handler (pi-agent-dashboard or pi-flows) instead of `role:resolve-model` / "roles-plugin bridge".
- [x] 1.2 Update the "resolves @fast" scenario to emit `model:resolve` with `probe.ref` and read `probe.model`/`probe.resolved` per the widened probe.
- [x] 1.3 Update the "hard-fails" scenario to the no-handler / in-process-fallback framing with the "install pi-agent-dashboard or pi-flows" messaging.
- [x] 1.4 Update the "operator override" scenario to note literals resolve via handler-or-fallback and no longer mention `role:resolve-model`.

## 2. Validation

- [x] 2.1 `openspec validate align-bundled-agents-to-model-resolve` — passes.
- [x] 2.2 After archive, `grep -rn 'role:resolve-model' openspec/specs/` returns no live-spec hits (CHANGELOG history refs are expected and correct).
- [x] 2.3 `openspec validate --specs` — all specs green.
