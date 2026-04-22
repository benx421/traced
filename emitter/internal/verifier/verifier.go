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
	client        *http.Client
}

// New creates a Verifier that will query targetURL and compare results against sent.
// windowMinutes must match the API's rolling-window configuration.
func New(targetURL string, windowMinutes int, sent map[string]emitter.SentRecord) *Verifier {
	return &Verifier{
		targetURL:     targetURL,
		windowMinutes: windowMinutes,
		sent:          sent,
		client:        &http.Client{Timeout: 30 * time.Second},
	}
}

// Run fetches traces from the API and checks for count mismatches and span-count
// errors. It returns a non-nil error if any check fails.
func (v *Verifier) Run() error {
	slog.Info("verifier starting")

	cutoff := time.Now().Add(-time.Duration(v.windowMinutes) * time.Minute)
	var expected []string
	for id, rec := range v.sent {
		if rec.SentAt.After(cutoff) {
			expected = append(expected, id)
		}
	}

	sample, total, err := v.fetchTraces()
	if err != nil {
		return fmt.Errorf("fetch traces: %w", err)
	}

	missing := len(expected) - total
	if missing < 0 {
		missing = 0
	}

	spanMismatches := v.sampleSpanCounts(expected, sample)

	pass := total >= len(expected) && spanMismatches == 0

	slog.Info("verification summary",
		"expected", len(expected),
		"found", total,
		"missing", missing,
		"span_mismatches", spanMismatches)

	if !pass {
		return fmt.Errorf("verification failed")
	}

	slog.Info("all checks passed")
	return nil
}

// fetchTraces fetches up to 1000 traces and returns the sample alongside the
// server-reported total. The API has no pagination cursor, so we use the total
// field for the aggregate count check and sample the returned page for span checks.
func (v *Verifier) fetchTraces() (sample []span.TraceSummary, total int, err error) {
	limit := min(len(v.sent), 1000)
	url := fmt.Sprintf("%s/traces?limit=%d", v.targetURL, limit)

	resp, err := v.client.Get(url)
	if err != nil {
		return nil, 0, fmt.Errorf("GET %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, 0, fmt.Errorf("GET %s: unexpected status %d", url, resp.StatusCode)
	}
	var result struct {
		Traces []span.TraceSummary `json:"traces"`
		Total  int                 `json:"total"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, 0, fmt.Errorf("decode response: %w", err)
	}
	return result.Traces, result.Total, nil
}

// sampleSpanCounts checks 10% of expected traces by fetching their full span list.
// It only samples from traces present in the returned page.
func (v *Verifier) sampleSpanCounts(expected []string, sample []span.TraceSummary) int {
	if len(expected) == 0 || len(sample) == 0 {
		return 0
	}

	sampleByID := make(map[string]struct{}, len(sample))
	for _, t := range sample {
		sampleByID[t.TraceID] = struct{}{}
	}

	// Restrict candidates to traces that appear in the returned page.
	var candidates []string
	for _, id := range expected {
		if _, ok := sampleByID[id]; ok {
			candidates = append(candidates, id)
		}
	}

	sampleSize := max(1, len(candidates)/10)
	indices := rand.Perm(len(candidates))
	if len(indices) > sampleSize {
		indices = indices[:sampleSize]
	}

	mismatches := 0
	for _, i := range indices {
		id := candidates[i]
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
				"got", len(spans))
			mismatches++
		}
	}
	return mismatches
}

func (v *Verifier) fetchTrace(traceID string) ([]span.Span, error) {
	url := fmt.Sprintf("%s/traces/%s", v.targetURL, traceID)
	resp, err := v.client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("GET %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: unexpected status %d", url, resp.StatusCode)
	}
	var result struct {
		Spans []span.Span `json:"spans"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	return result.Spans, nil
}
