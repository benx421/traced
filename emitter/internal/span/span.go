package span

type Span struct {
	TraceID      string            `json:"trace_id"`
	SpanID       string            `json:"span_id"`
	ParentSpanID string            `json:"parent_span_id,omitempty"`
	Service      string            `json:"service"`
	Operation    string            `json:"operation"`
	StartTime    int64             `json:"start_time"` // unix nanoseconds
	EndTime      int64             `json:"end_time"`   // unix nanoseconds
	Status       string            `json:"status"`     // "ok" | "error"
	Tags         map[string]string `json:"tags"`
}

// TraceSummary is the condensed view returned by GET /traces.
type TraceSummary struct {
	TraceID       string `json:"trace_id"`
	RootService   string `json:"root_service"`
	RootOperation string `json:"root_operation"`
	SpanCount     int    `json:"span_count"`
	DurationMs    int    `json:"duration_ms"` // root span wall-clock duration in milliseconds
	StartTime     int64  `json:"start_time"`
	Status        string `json:"status"`
}

type IngestRequest struct {
	Spans []Span `json:"spans"`
}
