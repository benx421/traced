package verifier

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"math/rand"
	"net/http"
	"time"

	"github.com/benx421/traced/emitter/internal/emitter"
	"github.com/benx421/traced/emitter/internal/span"
)

// Verifier cross-checks what the emitter sent against what the API returned.
type Verifier struct {
	targetURL     string
	windowMinutes int
	sent          map[string]emitter.SentRecord
}

// New creates a Verifier that will query targetURL and compare results against sent.
// windowMinutes must match the API's rolling-window configuration.
func New(targetURL string, windowMinutes int, sent map[string]emitter.SentRecord) *Verifier {
	return &Verifier{
		targetURL:     targetURL,
		windowMinutes: windowMinutes,
		sent:          sent,
	}
}

// Run fetches traces from the API and checks for missing, stale, and span-count
// mismatches. It returns a non-nil error if any check fails.
func (v *Verifier) Run() error {
	slog.Info("verifier starting")

	returned, err := v.fetchAllTraces()
	if err != nil {
		return fmt.Errorf("fetch traces: %w", err)
	}

	returnedByID := make(map[string]span.TraceSummary, len(returned))
	for _, t := range returned {
		returnedByID[t.TraceID] = t
	}

	cutoff := time.Now().Add(-time.Duration(v.windowMinutes) * time.Minute)

	var expected []string
	for id, rec := range v.sent {
		if rec.SentAt.After(cutoff) {
			expected = append(expected, id)
		}
	}

	var missing []string
	for _, id := range expected {
		if _, ok := returnedByID[id]; !ok {
			missing = append(missing, id)
		}
	}

	var stale []string
	for _, t := range returned {
		if _, ok := v.sent[t.TraceID]; !ok {
			stale = append(stale, t.TraceID)
		}
	}

	spanMismatches := v.sampleSpanCounts(expected, returnedByID)

	v.logIssues("missing traces", missing, 10)
	v.logIssues("stale traces", stale, 10)

	pass := len(missing) == 0 && len(stale) == 0 && spanMismatches == 0

	slog.Info("verification summary",
		"found", len(expected)-len(missing),
		"expected", len(expected),
		"missing", len(missing),
		"stale", len(stale),
		"span_mismatches", spanMismatches)

	if !pass {
		return fmt.Errorf("verification failed")
	}

	slog.Info("all checks passed")
	return nil
}

// fetchAllTraces pages through GET /traces until all results are collected.
func (v *Verifier) fetchAllTraces() ([]span.TraceSummary, error) {
	var all []span.TraceSummary
	limit := 100

	for {
		url := fmt.Sprintf("%s/traces?limit=%d", v.targetURL, limit)
		resp, err := http.Get(url) //nolint:noctx // verifier runs post-emission, no parent ctx
		if err != nil {
			return nil, fmt.Errorf("GET %s: %w", url, err)
		}

		var page []span.TraceSummary
		if err := json.NewDecoder(resp.Body).Decode(&page); err != nil {
			resp.Body.Close()
			return nil, fmt.Errorf("decode response: %w", err)
		}
		resp.Body.Close()

		all = append(all, page...)

		// Stop when the API returns fewer than a full page.
		if len(page) < limit {
			break
		}
	}

	return all, nil
}

// sampleSpanCounts checks 10% of expected traces by fetching their full span list.
func (v *Verifier) sampleSpanCounts(expected []string, returned map[string]span.TraceSummary) int {
	sampleSize := max(1, len(expected)/10)
	indices := rand.Perm(len(expected))
	if len(indices) > sampleSize {
		indices = indices[:sampleSize]
	}

	mismatches := 0
	for _, i := range indices {
		id := expected[i]
		summary, ok := returned[id]
		if !ok {
			continue // already counted as missing
		}

		spans, err := v.fetchTrace(id)
		if err != nil {
			slog.Warn("could not fetch trace", "trace_id", id, "err", err)
			continue
		}

		wantCount := v.sent[id].SpanCount
		if len(spans) != wantCount {
			slog.Warn("span mismatch",
				"trace_id", id,
				"sent", wantCount,
				"got_summary", summary.SpanCount,
				"got_detail", len(spans))
			mismatches++
		}
	}

	return mismatches
}

func (v *Verifier) fetchTrace(traceID string) ([]span.Span, error) {
	url := fmt.Sprintf("%s/traces/%s", v.targetURL, traceID)
	resp, err := http.Get(url) //nolint:noctx
	if err != nil {
		return nil, fmt.Errorf("GET %s: %w", url, err)
	}
	defer resp.Body.Close()

	var spans []span.Span
	if err := json.NewDecoder(resp.Body).Decode(&spans); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	return spans, nil
}

func (v *Verifier) logIssues(label string, ids []string, limit int) {
	if len(ids) == 0 {
		return
	}
	shown := ids
	if len(shown) > limit {
		shown = shown[:limit]
	}
	slog.Warn(label, "total", len(ids), "sample", shown)
}
