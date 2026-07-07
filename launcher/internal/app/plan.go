package app

import (
	"github.com/nexu-io/open-design/launcher/internal/contract"
	"github.com/nexu-io/open-design/launcher/internal/state"
)

// L0Plan is the L0 stub's decision after reading the launcher axis: whether to
// hand off to a newer delegated launcher, run the authority in-process, or show
// the reinstall fallback.
type L0Plan struct {
	Action HandoffAction
	Target *contract.Pointer
}

// PlanL0 is the pure L0 decision. It applies the crash-safe A/B + local schema
// floor to the launcher axis, then the single-handoff rule. schemaOK reports
// whether a launcher version's manifest schema is interpretable; binExists
// reports whether versions/<v>/launcher is present on disk.
func PlanL0(
	launcherRT contract.Runtime,
	launcherAttempt *contract.Attempt,
	rollbackThreshold int,
	selfVersion string,
	schemaOK func(version string) bool,
	binExists func(version string) bool,
) L0Plan {
	sel := state.SelectRunnable(launcherRT, launcherAttempt, rollbackThreshold, schemaOK)
	if !sel.Selected || sel.Pointer == nil {
		// Empty/incompatible launcher axis (genesis, or all delegated launchers
		// blocked) — the baked binary is itself a schema-compatible launcher, so run
		// the authority in-process. "Nothing runnable" is a PAYLOAD-axis (L1) verdict,
		// not an L0 one: L0 can always fall back to running itself.
		return L0Plan{Action: ActionRunAuthorityInline}
	}
	action := DecideHandoff(sel, selfVersion, binExists(sel.Pointer.Version))
	return L0Plan{Action: action, Target: sel.Pointer}
}

// PlanL1 is the pure L1 payload decision: the crash-safe A/B + local schema floor
// on the payload axis. A ReasonNone result means nothing runnable (fall back to
// the reinstall dialog). This is computed by the authority mode before booting
// the Electron payload it selects.
func PlanL1(
	payloadRT contract.Runtime,
	payloadAttempt *contract.Attempt,
	rollbackThreshold int,
	schemaOK func(version string) bool,
) state.Selection {
	return state.SelectRunnable(payloadRT, payloadAttempt, rollbackThreshold, schemaOK)
}
