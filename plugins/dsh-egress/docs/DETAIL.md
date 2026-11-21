# Model Egress

Manage the proxies that model requests leave the server through, and choose one per model endpoint.

- Exits: `direct` (built in), `http`, `https`, `socks5` (the proxy resolves the host name, socks5h semantics). Add as many as you like.
- Bindings: each model endpoint host is bound to one exit; unbound hosts use the default exit.
- Applies instantly: the next request already uses the new choice, no restart.
- Fail-closed: if the chosen exit is unreachable, the request fails with an error that names the exit. It never falls back to a direct connection.
- Probe: checks an exit against a fixed IP echo endpoint and shows the exit IP and latency.
- Credentials of a proxy are stored in a 0600 file and are never sent back to the browser.