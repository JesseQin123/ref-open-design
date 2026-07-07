package state

import (
	"path/filepath"
	"testing"

	"github.com/nexu-io/open-design/launcher/internal/contract"
)

func ptr(version string, gen int) *contract.Pointer {
	return &contract.Pointer{Version: version, Generation: gen}
}

func TestResolvePaths(t *testing.T) {
	p := Resolve("/data", contract.Config{Channel: "beta", Namespace: "release-beta-win"})
	wantRoot := filepath.Join("/data", "launcher", "channels", "beta", "namespaces", "release-beta-win")
	if p.Root != wantRoot {
		t.Fatalf("Root = %q, want %q", p.Root, wantRoot)
	}
	if p.PayloadRuntime != filepath.Join(wantRoot, "runtime.json") {
		t.Fatalf("payload runtime path wrong: %q", p.PayloadRuntime)
	}
	if p.LauncherRuntime != filepath.Join(wantRoot, "launcher-runtime.json") {
		t.Fatalf("launcher runtime path wrong: %q", p.LauncherRuntime)
	}
	if p.ManifestPath("1.2.0") != filepath.Join(wantRoot, "versions", "1.2.0", "manifest.json") {
		t.Fatalf("manifest path wrong: %q", p.ManifestPath("1.2.0"))
	}
	if p.PayloadRoot("1.2.0") != filepath.Join(wantRoot, "versions", "1.2.0", "payload") {
		t.Fatalf("payload root wrong: %q", p.PayloadRoot("1.2.0"))
	}
}

func TestJSONRoundTripAndMissing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "runtime.json")

	if _, ok, err := ReadJSON[contract.Runtime](path); err != nil || ok {
		t.Fatalf("missing file must be (zero,false,nil); got ok=%v err=%v", ok, err)
	}

	in := contract.Runtime{SchemaVersion: 1, Channel: "beta", Namespace: "ns", Active: ptr("2.0.0", 3), LastSuccessful: ptr("1.0.0", 1)}
	if err := WriteJSON(path, in); err != nil {
		t.Fatalf("WriteJSON: %v", err)
	}
	got, ok, err := ReadJSON[contract.Runtime](path)
	if err != nil || !ok {
		t.Fatalf("ReadJSON after write: ok=%v err=%v", ok, err)
	}
	if got.Active == nil || got.Active.Version != "2.0.0" || got.Active.Generation != 3 || got.LastSuccessful.Version != "1.0.0" {
		t.Fatalf("round-trip mismatch: %+v", got)
	}

	if err := RemoveIfExists(path); err != nil {
		t.Fatalf("RemoveIfExists: %v", err)
	}
	if err := RemoveIfExists(path); err != nil {
		t.Fatalf("RemoveIfExists on absent must be nil: %v", err)
	}
}

func TestForwardCompatPayloadRuntimeShape(t *testing.T) {
	// The payload runtime.json must serialise to exactly the launcher-proto keys
	// (no available/skipped), so existing TypeScript readers keep validating it.
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime.json")
	if err := WriteJSON(path, contract.Runtime{SchemaVersion: 1, Channel: "beta", Namespace: "ns", Active: ptr("1.0.0", 0), LastSuccessful: ptr("1.0.0", 0)}); err != nil {
		t.Fatal(err)
	}
	raw, _, err := ReadJSON[map[string]any](path)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"available", "skipped"} {
		if _, present := raw[forbidden]; present {
			t.Fatalf("payload runtime.json must not carry %q (breaks forward-compat)", forbidden)
		}
	}
	for _, required := range []string{"schemaVersion", "channel", "namespace", "active", "lastSuccessful"} {
		if _, present := raw[required]; !present {
			t.Fatalf("payload runtime.json missing launcher-proto key %q", required)
		}
	}
}

func TestSelect(t *testing.T) {
	stale := func(p *contract.Pointer, fails int) *contract.Attempt {
		return &contract.Attempt{Version: p.Version, Generation: p.Generation, FailCount: fails}
	}
	active := ptr("2.0.0", 1)
	last := ptr("1.0.0", 0)

	// Genesis: nothing runnable.
	if s := Select(contract.Runtime{}, nil, 1); s.Selected || s.Reason != ReasonNone {
		t.Fatalf("genesis must be ReasonNone, got %+v", s)
	}
	// No active but a lastSuccessful → run it.
	if s := Select(contract.Runtime{LastSuccessful: last}, nil, 1); !s.Selected || s.Reason != ReasonLastSuccessful || s.Pointer.Version != "1.0.0" {
		t.Fatalf("no-active must fall back to last-successful, got %+v", s)
	}
	// Clean active, no attempt → run active.
	if s := Select(contract.Runtime{Active: active, LastSuccessful: last}, nil, 1); !s.Selected || s.Reason != ReasonActive {
		t.Fatalf("clean active must run, got %+v", s)
	}
	// Stale attempt matching active, threshold 1 → roll back on first failure.
	if s := Select(contract.Runtime{Active: active, LastSuccessful: last}, stale(active, 0), 1); s.Reason != ReasonLastSuccessful {
		t.Fatalf("threshold 1 must roll back on first stale attempt, got %+v", s)
	}
	// Stale attempt but no lastSuccessful → cannot roll back, retry active.
	if s := Select(contract.Runtime{Active: active}, stale(active, 5), 1); s.Reason != ReasonActive {
		t.Fatalf("no last-successful means retry active, got %+v", s)
	}
	// Threshold 2: first stale retries active, second stale rolls back.
	if s := Select(contract.Runtime{Active: active, LastSuccessful: last}, stale(active, 0), 2); s.Reason != ReasonActive {
		t.Fatalf("threshold 2 first failure must retry active, got %+v", s)
	}
	if s := Select(contract.Runtime{Active: active, LastSuccessful: last}, stale(active, 1), 2); s.Reason != ReasonLastSuccessful {
		t.Fatalf("threshold 2 second failure must roll back, got %+v", s)
	}
	// A stale attempt for a DIFFERENT version than active is not a crash marker.
	if s := Select(contract.Runtime{Active: active, LastSuccessful: last}, stale(ptr("1.5.0", 0), 9), 1); s.Reason != ReasonActive {
		t.Fatalf("attempt for another version must not trigger rollback, got %+v", s)
	}
}

func TestSelectRunnableSchemaFloor(t *testing.T) {
	active := ptr("2.0.0", 1)
	last := ptr("1.0.0", 0)
	allOK := func(string) bool { return true }
	only := func(v string) func(string) bool {
		return func(candidate string) bool { return candidate == v }
	}

	// Compatible active → run it (C4).
	if s := SelectRunnable(contract.Runtime{Active: active, LastSuccessful: last}, nil, 1, allOK); s.Reason != ReasonActive {
		t.Fatalf("compatible active must run, got %+v", s)
	}
	// Active schema-incompatible, lastSuccessful compatible → fall back (C3).
	if s := SelectRunnable(contract.Runtime{Active: active, LastSuccessful: last}, nil, 1, only("1.0.0")); s.Reason != ReasonLastSuccessful || s.Pointer.Version != "1.0.0" {
		t.Fatalf("incompatible active must fall back to compatible last-successful, got %+v", s)
	}
	// Both incompatible → nothing runnable (C3 → A5).
	if s := SelectRunnable(contract.Runtime{Active: active, LastSuccessful: last}, nil, 1, func(string) bool { return false }); s.Selected || s.Reason != ReasonNone {
		t.Fatalf("all-incompatible must be ReasonNone, got %+v", s)
	}
}

func TestNextAttempt(t *testing.T) {
	cfg := contract.Config{Channel: "beta", Namespace: "ns"}
	target := contract.Pointer{Version: "2.0.0", Generation: 1}

	fresh := NextAttempt(nil, cfg, target)
	if fresh.FailCount != 0 || fresh.Version != "2.0.0" || fresh.Channel != "beta" || fresh.SchemaVersion != contract.RuntimeSchema {
		t.Fatalf("fresh attempt wrong: %+v", fresh)
	}
	// A retry of the same version increments the crash-loop counter.
	retry := NextAttempt(&contract.Attempt{Version: "2.0.0", Generation: 1, FailCount: 1}, cfg, target)
	if retry.FailCount != 2 {
		t.Fatalf("retry must increment FailCount to 2, got %d", retry.FailCount)
	}
	// A different version resets the counter.
	reset := NextAttempt(&contract.Attempt{Version: "1.0.0", Generation: 0, FailCount: 5}, cfg, target)
	if reset.FailCount != 0 {
		t.Fatalf("new version must reset FailCount, got %d", reset.FailCount)
	}
}
