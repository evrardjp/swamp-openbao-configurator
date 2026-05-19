# openbao-configurator

A [swamp](https://github.com/systeminit/swamp) extension that deploys and manages [OpenBao](https://openbao.org/) configuration over SSH. It renders an HCL config file from typed inputs, copies it to the target host, and restarts the service — all tracked as swamp model state.

## What it does

- Renders an OpenBao HCL config (raft storage, TCP listener, TLS, UI toggle, cluster/API addresses)
- Deploys the config via SCP and installs it at the configured path
- Ensures the storage directory exists with correct ownership
- Restarts the `openbao` systemd service and verifies it is active
- Records the deployed state as a swamp resource for use in downstream models and CEL expressions

## Prerequisites

- [swamp](https://github.com/systeminit/swamp) installed and initialized (`swamp init`)
- SSH access to the target host with a user that has passwordless `sudo`
- OpenBao installed on the target host (the `openbao` user and systemd unit must exist)

## Installation

Pull the extension from the registry:

```sh
swamp extension pull @evrardjp/openbao-configurator
```

## Usage

### Create a model instance

```sh
swamp model create my-bao \
  --type @evrardjp/openbao-configurator \
  --arg host=192.168.1.10 \
  --arg sshUser=admin \
  --arg sshKeyPath=~/.ssh/id_ed25519
```

### Verify SSH connectivity

```sh
swamp model check run my-bao ssh-reachable
```

### Deploy the configuration

```sh
swamp model method run my-bao deploy \
  --arg listener.address=0.0.0.0:8200 \
  --arg clusterAddr=https://192.168.1.10:8201 \
  --arg apiAddr=https://192.168.1.10:8200
```

With TLS disabled (e.g. for a dev environment):

```sh
swamp model method run my-bao deploy \
  --arg listener.address=0.0.0.0:8200 \
  --arg listener.tlsDisable=true \
  --arg clusterAddr=http://192.168.1.10:8201 \
  --arg apiAddr=http://192.168.1.10:8200 \
  --arg ui=true
```

### Inspect the deployed state

```sh
swamp model get my-bao --json
```

### Use the deployed config in a downstream model

Reference the recorded state with a CEL expression:

```
data.latest("my-bao", "config").attributes.apiAddr
```

## Configuration reference

### Global arguments (set on the model)

| Argument     | Default              | Description                    |
|--------------|----------------------|--------------------------------|
| `host`       | *(required)*         | SSH host IP or hostname        |
| `sshUser`    | `admin`              | SSH user                       |
| `sshKeyPath` | `~/.ssh/id_ed25519`  | Path to SSH private key        |

### `deploy` method arguments

| Argument              | Default                        | Description                                         |
|-----------------------|--------------------------------|-----------------------------------------------------|
| `ui`                  | `false`                        | Enable the OpenBao web UI                           |
| `storage.path`        | `/var/lib/openbao/data`        | Raft storage data directory                         |
| `storage.nodeId`      | `vault-node-1`                 | Raft node identifier                                |
| `listener.address`    | *(required)*                   | Listener address in `host:port` format              |
| `listener.tlsDisable` | `false`                        | Disable TLS on this listener                        |
| `listener.tlsCertFile`| `/etc/openbao/tls/openbao.crt` | Path to TLS certificate on the remote host          |
| `listener.tlsKeyFile` | `/etc/openbao/tls/openbao.key` | Path to TLS private key on the remote host          |
| `clusterAddr`         | *(required)*                   | Cluster advertise address (e.g. `https://host:8201`)|
| `apiAddr`             | *(required)*                   | API advertise address (e.g. `https://host:8200`)    |
| `configPath`          | `/etc/openbao/openbao.hcl`     | Remote path for the deployed HCL config file        |

## Development

The extension source lives in `extensions/models/openbao_configurator.ts`. To iterate locally:

```sh
# Bundle and smoke-test against the local swamp daemon
swamp extension bundle
swamp model create test-bao --type @evrardjp/openbao-configurator --arg host=...
```

See the [swamp extension docs](https://github.com/systeminit/swamp) for the full development workflow.

## License

MIT — see [LICENSE](LICENSE.txt).
