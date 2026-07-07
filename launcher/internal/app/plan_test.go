package app

import (
	"testing"

	"github.com/nexu-io/open-design/launcher/internal/contract"
	"github.com/nexu-io/open-design/launcher/internal/state"
)

func p(v string, gen int) *contract.Pointer { return &contract.Pointer{Version: v, Generation: gen} }

func yes(string) bool { return true }
func no(string) bool  { return false }

func TestPlanL0(t *testing.T) {
	self := "1.0.0"

	// A1 genesis: active == baked build, its binary present → run authority inline
	// (no handoff, the baked binary IS the newest launcher).
	if pl := PlanL0(contract.Runtime{Active: p("1.0.0", 0), LastSuccessful: p("1.0.0", 0)}, nil, 2, self, yes, yes); pl.Action != ActionRunAuthorityInline {
		t.Fatalf("A1 genesis must run authority inline, got %v", pl.Action)
	}
	// B3: a newer delegated launcher with its binary present → hand off.
	if pl := PlanL0(contract.Runtime{Active: p("1.1.0", 0), LastSuccessful: p("1.0.0", 0)}, nil, 2, self, yes, yes); pl.Action != ActionHandoff || pl.Target.Version != "1.1.0" {
		t.Fatalf("B3 newer launcher must hand off to 1.1.0, got %+v", pl)
	}
	// Genesis: empty launcher axis → run the baked authority inline (NOT nothing-
	// runnable; L0 can always fall back to itself).
	if pl := PlanL0(contract.Runtime{}, nil, 2, self, yes, yes); pl.Action != ActionRunAuthorityInline {
		t.Fatalf("empty launcher axis must run authority inline, got %v", pl.Action)
	}
	// C3 on the launcher axis: newer launcher exists but its schema is too new →
	// falls back to the compatible last-successful and runs inline (not handoff).
	onlyOld := func(v string) bool { return v == "1.0.0" }
	if pl := PlanL0(contract.Runtime{Active: p("1.1.0", 0), LastSuccessful: p("1.0.0", 0)}, nil, 2, self, onlyOld, yes); pl.Action != ActionRunAuthorityInline || pl.Target.Version != "1.0.0" {
		t.Fatalf("C3 schema-too-new launcher must fall back + run inline on 1.0.0, got %+v", pl)
	}
	// B4 launcher rollback: newer launcher active with a stale attempt matching it
	// (crashed before confirming) and a compatible last-successful → roll back, run
	// the older launcher inline.
	staleNew := &contract.Attempt{Version: "1.1.0", Generation: 0, FailCount: 1}
	if pl := PlanL0(contract.Runtime{Active: p("1.1.0", 0), LastSuccessful: p("1.0.0", 0)}, staleNew, 2, self, yes, yes); pl.Action != ActionRunAuthorityInline || pl.Target.Version != "1.0.0" {
		t.Fatalf("B4 crashed newer launcher must roll back to 1.0.0 inline, got %+v", pl)
	}
	// D3: newer launcher selected but its binary is missing on disk → run inline
	// (never hand off to a phantom).
	if pl := PlanL0(contract.Runtime{Active: p("1.1.0", 0), LastSuccessful: p("1.0.0", 0)}, nil, 2, self, yes, no); pl.Action != ActionRunAuthorityInline {
		t.Fatalf("D3 missing launcher binary must run inline, got %v", pl.Action)
	}
}

func TestPlanL1(t *testing.T) {
	// A3 payload rollback: stale attempt matches active, compatible last-successful.
	staleActive := &contract.Attempt{Version: "2.0.0", Generation: 1, FailCount: 1}
	if s := PlanL1(contract.Runtime{Active: p("2.0.0", 1), LastSuccessful: p("1.0.0", 0)}, staleActive, 1, yes); s.Reason != state.ReasonLastSuccessful || s.Pointer.Version != "1.0.0" {
		t.Fatalf("A3 payload rollback must select last-successful, got %+v", s)
	}
	// Healthy payload update: clean active, compatible → run it.
	if s := PlanL1(contract.Runtime{Active: p("2.0.0", 1), LastSuccessful: p("1.0.0", 0)}, nil, 1, yes); s.Reason != state.ReasonActive {
		t.Fatalf("healthy payload must run active, got %+v", s)
	}
	// C3 payload floor: active schema too new, last-successful compatible → fall back.
	if s := PlanL1(contract.Runtime{Active: p("2.0.0", 1), LastSuccessful: p("1.0.0", 0)}, nil, 1, func(v string) bool { return v == "1.0.0" }); s.Reason != state.ReasonLastSuccessful {
		t.Fatalf("C3 payload floor must fall back, got %+v", s)
	}
	// A5 nothing runnable: empty payload axis → ReasonNone (L1 surfaces the reinstall
	// fallback; this is the payload-axis "nothing runnable", the real CS4 trigger).
	if s := PlanL1(contract.Runtime{}, nil, 1, yes); s.Selected || s.Reason != state.ReasonNone {
		t.Fatalf("A5 empty payload axis must be ReasonNone, got %+v", s)
	}
}
