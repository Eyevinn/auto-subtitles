/**
 * Lightweight Prometheus-compatible metrics for the auto-subtitles service.
 *
 * Exposes counters, gauges, and histograms via a /metrics endpoint
 * in the standard Prometheus text exposition format.
 *
 * No external dependencies -- this is a minimal, zero-dep implementation
 * to avoid bloating the production image.
 */

// ---- Metric types ----

class Counter {
  private name: string;
  private help: string;
  private labels: Map<string, number> = new Map();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  inc(labels: Record<string, string> = {}, value = 1): void {
    const key = this.labelsKey(labels);
    this.labels.set(key, (this.labels.get(key) ?? 0) + value);
  }

  serialize(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`
    ];
    for (const [key, val] of this.labels) {
      lines.push(`${this.name}${key} ${val}`);
    }
    if (this.labels.size === 0) {
      lines.push(`${this.name} 0`);
    }
    return lines.join('\n');
  }

  private labelsKey(labels: Record<string, string>): string {
    const entries = Object.entries(labels);
    if (entries.length === 0) return '';
    return '{' + entries.map(([k, v]) => `${k}="${v}"`).join(',') + '}';
  }
}

class Gauge {
  private name: string;
  private help: string;
  private value = 0;

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  set(val: number): void {
    this.value = val;
  }

  inc(val = 1): void {
    this.value += val;
  }

  dec(val = 1): void {
    this.value -= val;
  }

  serialize(): string {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
      `${this.name} ${this.value}`
    ].join('\n');
  }
}

class Histogram {
  private name: string;
  private help: string;
  private buckets: number[];
  private counts: number[];
  private sum = 0;
  private count = 0;

  constructor(name: string, help: string, buckets?: number[]) {
    this.name = name;
    this.help = help;
    this.buckets = buckets ?? [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600];
    this.counts = new Array(this.buckets.length).fill(0);
  }

  observe(value: number): void {
    this.sum += value;
    this.count++;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) {
        this.counts[i]++;
      }
    }
  }

  serialize(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`
    ];
    let cumulative = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      cumulative += this.counts[i];
      lines.push(`${this.name}_bucket{le="${this.buckets[i]}"} ${cumulative}`);
    }
    lines.push(`${this.name}_bucket{le="+Inf"} ${this.count}`);
    lines.push(`${this.name}_sum ${this.sum}`);
    lines.push(`${this.name}_count ${this.count}`);
    return lines.join('\n');
  }
}

// ---- Application metrics ----

/**
 * Total transcription requests.
 * Recommended labels: { model, format, endpoint }
 *   model:    "whisper-1" | "gpt-4o-transcribe" | "gpt-4o-mini-transcribe" | etc.
 *   format:   "vtt" | "srt" | "json" | "text"
 *   endpoint: "transcribe" | "transcribe_s3"
 */
export const transcriptionTotal = new Counter(
  'auto_subtitles_transcriptions_total',
  'Total number of transcription requests'
);

/**
 * Failed transcription requests.
 * Recommended labels: { model, error_type }
 */
export const transcriptionErrors = new Counter(
  'auto_subtitles_transcription_errors_total',
  'Total number of failed transcription requests'
);

/**
 * Diarization requests (gpt-4o-transcribe-diarize model).
 * Recommended labels: { has_known_speakers }
 */
export const diarizationTotal = new Counter(
  'auto_subtitles_diarization_requests_total',
  'Total number of diarization transcription requests'
);

/**
 * Server-side subtitle format generation from JSON (for gpt-4o models
 * that do not natively support SRT/VTT output).
 * Recommended labels: { format, model }
 */
export const formatGenerationTotal = new Counter(
  'auto_subtitles_format_generation_total',
  'Subtitle format conversions generated server-side from JSON'
);

export const transcriptionDuration = new Histogram(
  'auto_subtitles_transcription_duration_seconds',
  'Duration of transcription jobs in seconds',
  [1, 5, 10, 30, 60, 120, 300, 600, 1800]
);

export const activeWorkers = new Gauge(
  'auto_subtitles_active_workers',
  'Number of currently active transcription workers'
);

export const totalWorkers = new Gauge(
  'auto_subtitles_total_workers',
  'Total number of transcription workers created'
);

/**
 * Returns the full /metrics body in Prometheus text exposition format.
 */
export function serializeMetrics(): string {
  return (
    [
      transcriptionTotal.serialize(),
      transcriptionErrors.serialize(),
      diarizationTotal.serialize(),
      formatGenerationTotal.serialize(),
      transcriptionDuration.serialize(),
      activeWorkers.serialize(),
      totalWorkers.serialize()
    ].join('\n\n') + '\n'
  );
}
