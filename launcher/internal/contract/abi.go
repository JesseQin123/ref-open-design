// Package contract is the fossil layer: the frozen handshake vocabulary and the
// JSON document schemas that any-age launcher and any-age Electron payload agree
// on. Changing anything here is a reseed (installer), not a seamless update.
// Every other package is mechanism layered on top of these definitions.
//
// This is the Open Design port of the Go launcher PoC, adapted to OD's decisions
// (see .task/MAIN.md). The load-bearing divergences from the PoC:
//
//   - The launcher is NETWORK-FREE: it never downloads. New payloads and new
//     launcher binaries are fetched by the Electron payload's updater and arrive
//     on disk; the launcher only selects, spawns, supervises, and rolls back.
//   - The launcher spawns exactly ONE child — Electron — and is blind to whatever
//     Electron spawns below it (daemon/web). Coupling is loose, by convention.
//   - Boot health is heartbeat-during-boot (no fixed ReadyGrace): OD's daemon can
//     take ~35s normally and up to ~30min under legacy-data migration, so the
//     launcher acts only on a MISSED heartbeat or a process exit.
package contract

import "time"

// SelfVersion is the launcher's own baked build stamp (identity; never
// overridable). Set via:
//
//	-ldflags "-X github.com/nexu-io/open-design/launcher/internal/contract.SelfVersion=X.Y.Z"
var SelfVersion = "0.0.0"

// SupportedLauncherSchema is the launcher-contract grammar this build can
// interpret — the `launcher.schema` axis of the hierarchical schema declaration.
// A release/manifest declaring a higher launcher schema cannot be adopted and
// routes to the installer (fail-open), never a crash. Mirrors the TypeScript
// LAUNCHER_SCHEMA_VERSION so the two readers stay consistent (Q4 conformance).
const SupportedLauncherSchema = 1

// RuntimeSchema is the on-disk document format version stamped into runtime.json
// and attempt.json (the launcher-proto `schemaVersion` field). Distinct from
// SupportedLauncherSchema (the payload ABI axis); both are 1 today.
const RuntimeSchema = 1

// RollbackThreshold is the default CS2 crash-loop tolerance: roll back to
// lastSuccessful only after this many consecutive unconfirmed boots, so a single
// transient boot failure does not demote a good version. Contract-configurable.
const RollbackThreshold = 2

// Frozen identity handshake vocabulary. These names are ABI: additive-only,
// never renamed. The launcher resolves identity and injects it downward; remote
// content never contributes to these fields.
const (
	EnvNamespace = "OD_NAMESPACE"
	EnvChannel   = "OD_CHANNEL"
	EnvDataDir   = "OD_DATA_DIR"

	// Notify injection ABI: endpoint via argv, token via env (sd_notify shape;
	// the token stays out of argv because `ps` is world-readable).
	ArgNotifyEndpoint = "--od-notify-endpoint"
	EnvNotifyToken    = "OD_NOTIFY_TOKEN"

	// Launcher↔launcher stamp: a single frozen token carrying hop count, the
	// after-quit wait, and the deferred adopt choice.
	ArgStamp = "--od-stamp"
)

// After-quit hand-off argv — mirrors @open-design/launcher-proto so the Electron
// payload's relaunch (which targets the launcher binary) is understood verbatim.
const (
	ArgAfterQuit          = "--od-launcher-after-quit"
	ArgAfterQuitTargetPID = "--od-launcher-target-pid"
	ArgAfterQuitTimeoutMs = "--od-launcher-timeout-ms"
)

// Timings (mechanism policy; kept beside the ABI so the whole handshake contract
// reads in one place). There is deliberately NO ReadyGrace: under
// heartbeat-during-boot the launcher never gives up on a still-heartbeating
// payload, however long the boot takes.
const (
	HopCap = 4

	// HeartbeatGap is the maximum silence tolerated between payload heartbeats
	// before the payload is declared hung. The payload emits heartbeats from
	// process start (while it waits on daemon/web) until it reaches READY.
	HeartbeatGap = 10 * time.Second

	// LivenessHold is the post-READY stability window: the payload must survive
	// this long after READY (no exit, no dropped notify conn) before confirm.
	LivenessHold = 2 * time.Second

	// ShutdownGrace is how long a graceful stop is awaited before killing.
	ShutdownGrace = 3 * time.Second

	// DefaultAfterQuitTimeout bounds the wait for a prior instance to exit.
	DefaultAfterQuitTimeout = 10 * time.Second
)

// Now returns an RFC3339 UTC timestamp for state documents.
func Now() string { return time.Now().UTC().Format(time.RFC3339) }
