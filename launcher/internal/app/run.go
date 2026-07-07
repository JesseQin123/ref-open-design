package app

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/nexu-io/open-design/launcher/internal/contract"
	"github.com/nexu-io/open-design/launcher/internal/state"
)

// RelocatedElectronName is the fixed filename the packaging afterPack hook gives
// the real Electron binary once the launcher takes its bundle-executable slot.
const RelocatedElectronName = "od-electron"

// Run is the launcher entrypoint. It dispatches on the handoff hop: hop 0 runs the
// L0 stub (select the launcher axis, hand off to a newer delegated launcher or run
// the authority in-process); hop 1 runs the L1 authority. When identity is not yet
// configured (dev / unconfigured), it degrades to the plain trampoline so the app
// still comes up.
func Run(argv []string) int {
	stamp := contract.ParseStamp(argv)
	cfg, err := contract.LoadConfig(os.Getenv)
	if err != nil {
		// No identity floor yet: behave as a transparent trampoline.
		return execElectron(argv, nil)
	}
	paths := state.Resolve(cfg.DataDir, cfg)
	if ModeForHop(stamp.Hop) == ModeStub {
		return runStub(cfg, paths, stamp, argv)
	}
	return runAuthority(cfg, paths, stamp, argv)
}

// runStub is the L0 flow: pick the launcher version and, if a newer delegated
// launcher is on disk, hand off to it exactly once; otherwise run the authority
// in-process. Nothing runnable → the reinstall fallback.
func runStub(cfg contract.Config, paths state.Paths, stamp contract.Stamp, argv []string) int {
	rt, _, err := state.ReadJSON[contract.Runtime](paths.LauncherRuntime)
	if err != nil {
		// Unreadable launcher axis: fall through to the authority (genesis path).
		return runAuthority(cfg, paths, stamp, argv)
	}
	attempt := readAttempt(paths.LauncherAttempt)
	plan := PlanL0(rt, attempt, contract.RollbackThreshold, contract.SelfVersion,
		func(v string) bool { return manifestSchemaOK(paths, v) },
		func(v string) bool { return fileExists(paths.LauncherBinary(v)) },
	)
	if plan.Action == ActionHandoff {
		// Attempt-before-handoff: a broken delegated launcher is covered by rollback.
		_ = state.WriteJSON(paths.LauncherAttempt, state.NextAttempt(attempt, cfg, *plan.Target))
		next := stamp
		next.Hop = stamp.Hop + 1
		return spawnAndWait(paths.LauncherBinary(plan.Target.Version), append(next.Args(), argv[1:]...))
	}
	// ActionRunAuthorityInline — the baked binary is the newest usable launcher.
	return runAuthority(cfg, paths, stamp, argv)
}

// runAuthority is the L1 flow. For now it execs the bound Electron and lets
// Electron's existing in-process selection run (no regression); the payload-axis
// PlanL1 select/confirm/rollback becomes authoritative in the "Electron defers to
// L1" increment, validated via the packaged E2E harness.
func runAuthority(cfg contract.Config, paths state.Paths, stamp contract.Stamp, argv []string) int {
	return execElectron(argv, map[string]string{contract.EnvChannel: cfg.Channel})
}

// execElectron spawns the relocated Electron sibling, forwarding argv + env (with
// any extra overrides) and propagating the exit code. Resident parent (room for
// later supervision); spawn-not-exec for Windows portability.
func execElectron(argv []string, extraEnv map[string]string) int {
	target, err := siblingExecutable(RelocatedElectronName)
	if err != nil {
		return 1
	}
	args := []string{}
	if len(argv) > 1 {
		args = argv[1:]
	}
	return spawnAndWaitEnv(target, args, extraEnv)
}

func siblingExecutable(name string) (string, error) {
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(self), name), nil
}

func spawnAndWait(bin string, args []string) int {
	return spawnAndWaitEnv(bin, args, nil)
}

func spawnAndWaitEnv(bin string, args []string, extraEnv map[string]string) int {
	cmd := exec.Command(bin, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.Env = os.Environ()
	for k, v := range extraEnv {
		cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%s", k, v))
	}
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return exit.ExitCode()
		}
		return 1
	}
	return 0
}

// readAttempt reads an attempt marker, returning nil when absent or unreadable so
// a missing marker reads as "no prior boot in flight".
func readAttempt(path string) *contract.Attempt {
	a, ok, err := state.ReadJSON[contract.Attempt](path)
	if err != nil || !ok {
		return nil
	}
	return &a
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// manifestSchemaOK reports whether a version's on-disk manifest declares a
// launcher schema this build can interpret (the local schema floor). A missing or
// unreadable manifest is treated as not-OK (do not run what we cannot verify).
func manifestSchemaOK(paths state.Paths, version string) bool {
	m, ok, err := state.ReadJSON[contract.Manifest](paths.ManifestPath(version))
	if err != nil || !ok {
		return false
	}
	return m.SchemaSupported()
}

// showReinstall is the CS4 terminal fallback: nothing runnable. For now it logs;
// the native OS dialog + download link is a later increment validated via SPEC.
func showReinstall(cfg contract.Config) {
	fmt.Fprintf(os.Stderr, "[od-launcher] nothing runnable for channel %q namespace %q — reinstall required\n", cfg.Channel, cfg.Namespace)
}
