package contract

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestVersionConformanceFixture asserts CmpVersion matches the shared fixture that
// the TypeScript compareLauncherVersions conformance test also verifies, so the two
// ports never drift (Q4). The fixture lives at launcher/testdata so both runtimes
// consume the same expected values.
func TestVersionConformanceFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "version-conformance.json"))
	if err != nil {
		t.Fatalf("read conformance fixture: %v", err)
	}
	var fixture struct {
		Cases []struct {
			A        string `json:"a"`
			B        string `json:"b"`
			Expected int    `json:"expected"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse conformance fixture: %v", err)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("conformance fixture has no cases")
	}
	for _, c := range fixture.Cases {
		if got := CmpVersion(c.A, c.B); got != c.Expected {
			t.Errorf("CmpVersion(%q, %q) = %d, fixture expects %d", c.A, c.B, got, c.Expected)
		}
	}
}
