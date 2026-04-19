package emitter

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/benx421/traced/emitter/internal/span"
	"github.com/google/uuid"
)

// Config holds all tunable parameters for the emitter.
type Config struct {
	TargetURL      string
	Workers        int
	Duration       time.Duration
	WindowMinutes  int
	OutOfOrderProb float64 // probability [0,1) of shuffling spans within a batch
	BatchSize      int
	Verify         bool
}

// SentRecord holds metadata about a successfully dispatched trace.
type SentRecord struct {
	SentAt    time.Time
	SpanCount int
}

// Emitter orchestrates the worker pool and dispatches span batches to the target API.
type Emitter struct {
	cfg  Config
	sent map[string]SentRecord // trace_id -> record; guarded by mu
	mu   sync.Mutex
}

// New constructs an Emitter with the given configuration.
func New(cfg Config) *Emitter {
	return &Emitter{
		cfg:  cfg,
		sent: make(map[string]SentRecord),
	}
}

// Sent returns a snapshot copy safe to read after Run returns.
func (e *Emitter) Sent() map[string]SentRecord {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make(map[string]SentRecord, len(e.sent))
	for k, v := range e.sent {
		out[k] = v
	}
	return out
}

type serviceOp struct {
	service   string
	operation string
}

var catalogue = []serviceOp{
	{"checkout", "place_order"},
	{"checkout", "apply_discount"},
	{"checkout", "calculate_tax"},
	{"inventory", "reserve_stock"},
	{"inventory", "check_availability"},
	{"payment", "authorise"},
	{"payment", "capture"},
	{"shipping", "create_label"},
	{"shipping", "estimate_delivery"},
	{"notification", "send_confirmation"},
}

func pickServiceOp(rng *rand.Rand) serviceOp {
	return catalogue[rng.Intn(len(catalogue))]
}

// Run launches cfg.Workers goroutines that POST traces until ctx is cancelled.
func (e *Emitter) Run(ctx context.Context) error {
	var (
		totalSpans  atomic.Int64
		totalTraces atomic.Int64
	)

	ticker := time.NewTicker(5 * time.Second)
	tickerDone := make(chan struct{})
	go func() {
		defer close(tickerDone)
		for {
			select {
			case <-ticker.C:
				slog.Info("progress",
					"spans", totalSpans.Load(),
					"traces", totalTraces.Load())
			case <-ctx.Done():
				return
			}
		}
	}()

	var wg sync.WaitGroup
	wg.Add(e.cfg.Workers)

	for i := range e.cfg.Workers {
		go func(workerID int) {
			defer wg.Done()
			rng := rand.New(rand.NewSource(time.Now().UnixNano() + int64(workerID)))
			e.runWorker(ctx, rng, &totalSpans, &totalTraces)
		}(i)
	}

	wg.Wait()
	ticker.Stop()
	<-tickerDone

	slog.Info("done", "spans", totalSpans.Load(), "traces", totalTraces.Load())

	return nil
}

func (e *Emitter) runWorker(
	ctx context.Context,
	rng *rand.Rand,
	totalSpans *atomic.Int64,
	totalTraces *atomic.Int64,
) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		// Accumulate spans from multiple traces until we hit BatchSize.
		var batch []span.Span
		var traceIDs []string
		var traceCounts []int
		for len(batch) < e.cfg.BatchSize {
			spans := e.generateTrace(rng)
			traceIDs = append(traceIDs, spans[0].TraceID)
			traceCounts = append(traceCounts, len(spans))
			batch = append(batch, spans...)
		}

		if err := e.postSpans(ctx, batch); err != nil {
			continue
		}

		now := time.Now()
		e.mu.Lock()
		for i, id := range traceIDs {
			e.sent[id] = SentRecord{SentAt: now, SpanCount: traceCounts[i]}
		}
		e.mu.Unlock()

		totalSpans.Add(int64(len(batch)))
		totalTraces.Add(int64(len(traceIDs)))
	}
}

func (e *Emitter) generateTrace(rng *rand.Rand) []span.Span {
	traceID := uuid.New().String()

	rootOp := pickServiceOp(rng)
	rootStart := time.Now().Add(-(time.Duration(rng.Intn(2000)) * time.Millisecond))
	rootDurationMs := 50 + rng.Intn(451) // [50, 500]
	rootEnd := rootStart.Add(time.Duration(rootDurationMs) * time.Millisecond)

	root := span.Span{
		TraceID:   traceID,
		SpanID:    uuid.New().String(),
		Service:   rootOp.service,
		Operation: rootOp.operation,
		StartTime: rootStart.UnixNano(),
		EndTime:   rootEnd.UnixNano(),
		Status:    statusString(rng),
		Tags:      map[string]string{},
	}

	spans := make([]span.Span, 0, 5)
	spans = append(spans, root)

	childCount := 1 + rng.Intn(4) // [1, 4]
	for range childCount {
		childOp := pickServiceOp(rng)

		// Child starts at a random offset within the root's duration.
		maxOffsetMs := rootDurationMs
		childOffsetMs := rng.Intn(maxOffsetMs + 1)
		childStart := rootStart.Add(time.Duration(childOffsetMs) * time.Millisecond)

		// Child duration: at most what remains of the root window.
		remainingMs := rootDurationMs - childOffsetMs
		childDurationMs := 10
		if remainingMs > 10 {
			childDurationMs = 10 + rng.Intn(remainingMs)
		}
		childEnd := childStart.Add(time.Duration(childDurationMs) * time.Millisecond)

		child := span.Span{
			TraceID:      traceID,
			SpanID:       uuid.New().String(),
			ParentSpanID: root.SpanID,
			Service:      childOp.service,
			Operation:    childOp.operation,
			StartTime:    childStart.UnixNano(),
			EndTime:      childEnd.UnixNano(),
			Status:       statusString(rng),
			Tags:         map[string]string{},
		}
		spans = append(spans, child)
	}

	if rng.Float64() < e.cfg.OutOfOrderProb {
		rng.Shuffle(len(spans), func(i, j int) {
			spans[i], spans[j] = spans[j], spans[i]
		})
	}

	return spans
}

// statusString returns "ok" 95% of the time, "error" 5%.
func statusString(rng *rand.Rand) string {
	if rng.Float64() < 0.95 {
		return "ok"
	}
	return "error"
}

func (e *Emitter) postSpans(ctx context.Context, spans []span.Span) error {
	payload := span.IngestRequest{Spans: spans}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal spans: %w", err)
	}

	req, err := http.NewRequestWithContext(
		ctx, http.MethodPost,
		e.cfg.TargetURL+"/spans",
		bytes.NewReader(body),
	)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("post /spans: %w", err)
	}
	defer func() {
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("post /spans: unexpected status %d", resp.StatusCode)
	}

	return nil
}
