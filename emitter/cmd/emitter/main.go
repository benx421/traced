package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"time"

	"github.com/benx421/traced/emitter/internal/emitter"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	target := flag.String("target", envString("TARGET_URL", "http://localhost:8080"),
		"Base URL of the Traced API (env: TARGET_URL)")

	workers := flag.Int("workers", envInt("WORKERS", 50),
		"Number of concurrent worker goroutines (env: WORKERS)")

	duration := flag.Duration("duration", envDuration("DURATION", 60*time.Second),
		"Total run duration, e.g. 60s, 5m (env: DURATION)")

	window := flag.Int("window", envInt("WINDOW_MINUTES", 30),
		"Rolling-window size in minutes, must match the API config (env: WINDOW_MINUTES)")

	disorder := flag.Float64("disorder", envFloat("OUT_OF_ORDER_PROB", 0.3),
		"Probability [0,1) of shuffling spans within a batch (env: OUT_OF_ORDER_PROB)")

	batch := flag.Int("batch", envInt("BATCH_SIZE", 10),
		"Maximum spans per ingest request (env: BATCH_SIZE)")

	verify := flag.Bool("verify", envBool("VERIFY", true),
		"Run the post-emission verifier when done (env: VERIFY)")

	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: emitter [flags]\n\n")
		flag.PrintDefaults()
	}

	flag.Parse()

	slog.Info("starting",
		"target", *target,
		"workers", *workers,
		"duration", *duration,
		"window_min", *window,
		"disorder", *disorder,
		"batch", *batch,
		"verify", *verify,
	)

	cfg := emitter.Config{
		TargetURL:      *target,
		Workers:        *workers,
		Duration:       *duration,
		WindowMinutes:  *window,
		OutOfOrderProb: *disorder,
		BatchSize:      *batch,
		Verify:         *verify,
	}

	e := emitter.New(cfg)

	ctx, cancel := context.WithTimeout(context.Background(), *duration)
	defer cancel()

	if err := e.Run(ctx); err != nil {
		return fmt.Errorf("emitter run: %w", err)
	}

	if *verify {
		slog.Warn("verifier not yet implemented")
	}

	return nil
}

func envString(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envFloat(key string, def float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}

func envBool(key string, def bool) bool {
	if v := os.Getenv(key); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}
