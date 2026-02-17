# Subtitle Quality Metrics and Scoring System

## 1. Overview

This document defines a programmatic quality scoring system for subtitles produced by auto-subtitles. The scoring system evaluates individual subtitle segments and produces both per-segment scores and an aggregate score for the entire subtitle file.

The scoring system is designed to be:

- **Deterministic:** Same input always produces same score
- **Language-aware:** Adjusts thresholds based on target language
- **Granular:** Identifies specific types of quality issues
- **Actionable:** Each penalty maps to a specific fixable problem

---

## 2. Scoring Scale

| Score Range | Quality Level | Description                                   |
| ----------- | ------------- | --------------------------------------------- |
| 90-100      | Excellent     | Broadcast-ready, meets all major standards    |
| 75-89       | Good          | Minor issues, acceptable for most use cases   |
| 60-74       | Fair          | Noticeable issues, may require manual review  |
| 40-59       | Poor          | Significant issues, should be corrected       |
| 0-39        | Failing       | Major problems, not suitable for distribution |

Each subtitle segment starts at a score of 100 and receives deductions for quality violations. The final file score is the weighted average of all segment scores.

---

## 3. Metric Categories

### 3.1 Reading Speed (CPS - Characters Per Second)

Measures whether the viewer has sufficient time to read the subtitle.

**Calculation:**

```
CPS = characterCount / duration
```

Where `characterCount` excludes newline characters and `duration` is `end - start` in seconds.

**Scoring rules:**

| Condition                               | Deduction                    | Rationale                                  |
| --------------------------------------- | ---------------------------- | ------------------------------------------ |
| CPS <= target CPS for language          | 0                            | Within reading speed limit                 |
| CPS > target by 1-3 CPS                 | -5 per excess CPS            | Slightly fast                              |
| CPS > target by 3-6 CPS                 | -10 per excess CPS (above 3) | Notably fast                               |
| CPS > target + 6                        | -30 flat penalty             | Unreadable at normal reading speed         |
| CPS < 3 (too slow / wasted screen time) | -5                           | Subtitle displayed much longer than needed |

**Language-specific target CPS:**

| Language | Target CPS | Max Acceptable CPS |
| -------- | ---------- | ------------------ |
| en       | 15         | 20                 |
| de       | 20         | 25                 |
| fr       | 17         | 22                 |
| es       | 17         | 22                 |
| it       | 16         | 21                 |
| zh       | 6          | 9                  |
| ja       | 5          | 8                  |
| ko       | 6          | 9                  |
| ar       | 11         | 15                 |
| default  | 12         | 17                 |

### 3.2 Characters Per Line (CPL)

Measures whether lines fit within the display area.

**Calculation:**

```
CPL = max(lineLength for each line in segment)
```

**Scoring rules:**

| Condition                  | Deduction                    | Rationale                  |
| -------------------------- | ---------------------------- | -------------------------- |
| CPL <= target for language | 0                            | Within limits              |
| CPL exceeds by 1-5 chars   | -3 per excess char           | Minor overflow             |
| CPL exceeds by 6-10 chars  | -5 per excess char (above 5) | Visible overflow           |
| CPL exceeds by 11+ chars   | -20 flat penalty             | Likely truncated on screen |

### 3.3 Line Count

Measures whether the segment has an acceptable number of lines.

**Scoring rules:**

| Condition | Deduction | Rationale                |
| --------- | --------- | ------------------------ |
| 1-2 lines | 0         | Standard                 |
| 3 lines   | -15       | Exceeds standard maximum |
| 4+ lines  | -30       | Severely non-compliant   |

### 3.4 Duration

Measures whether the subtitle is displayed for an appropriate amount of time.

**Scoring rules:**

| Condition                | Deduction | Rationale                              |
| ------------------------ | --------- | -------------------------------------- |
| 1.0s <= duration <= 7.0s | 0         | Within standard range                  |
| 0.83s <= duration < 1.0s | -5        | Below ideal but within Netflix minimum |
| duration < 0.83s         | -15       | Too short, likely unreadable           |
| 7.0s < duration <= 8.0s  | -5        | Slightly too long                      |
| duration > 8.0s          | -15       | Much too long, should be split         |

### 3.5 Line Breaking Quality

Measures whether line breaks occur at linguistically appropriate positions.

**Scoring rules:**

| Condition                                      | Deduction | Rationale                      |
| ---------------------------------------------- | --------- | ------------------------------ |
| Break after sentence-ending punctuation        | 0         | Ideal break point              |
| Break after comma, semicolon, colon            | 0         | Good break point               |
| Break before conjunction (and, but, or, etc.)  | 0         | Good break point               |
| Break before preposition (in, on, at, etc.)    | -2        | Acceptable but not ideal       |
| Break between article and noun                 | -10       | Bad: splits tightly-bound pair |
| Break between adjective and noun               | -8        | Bad: splits modifier from head |
| Break between first and last name              | -10       | Bad: splits name               |
| Break between auxiliary and main verb          | -8        | Bad: splits verb phrase        |
| Break between negation and verb                | -10       | Bad: changes emphasis          |
| Break between verb and particle (phrasal verb) | -8        | Bad: splits semantic unit      |

### 3.6 Line Balance

Measures whether line lengths are well-distributed.

**Calculation:**

```
ratio = shorterLineLength / longerLineLength
```

**Scoring rules (for 2-line subtitles only):**

| Condition           | Deduction | Rationale                                 |
| ------------------- | --------- | ----------------------------------------- |
| ratio >= 0.5        | 0         | Well balanced                             |
| 0.35 <= ratio < 0.5 | -3        | Slightly unbalanced                       |
| 0.2 <= ratio < 0.35 | -6        | Notably unbalanced                        |
| ratio < 0.2         | -10       | Very unbalanced (e.g. 40 chars / 5 chars) |

### 3.7 Gap Between Subtitles

Measures whether there is adequate gap between consecutive subtitles.

**Scoring rules:**

| Condition                         | Deduction | Rationale                                         |
| --------------------------------- | --------- | ------------------------------------------------- |
| gap >= 0.083s (2 frames at 24fps) | 0         | Adequate gap                                      |
| 0 < gap < 0.083s                  | -5        | Too small, eye may not register change            |
| gap == 0 (back-to-back)           | -8        | No gap, viewer cannot distinguish subtitle change |
| gap < 0 (overlap)                 | -20       | Segments overlap in time                          |

### 3.8 Empty or Whitespace-Only Segments

| Condition                                | Deduction | Rationale                                |
| ---------------------------------------- | --------- | ---------------------------------------- |
| Segment text is empty or whitespace-only | -50       | Critical error: blank subtitle displayed |

### 3.9 Speaker Attribution (Diarization-Aware)

When diarization data is available (from gpt-4o-transcribe-diarize), additional metrics apply:

**Scoring rules:**

| Condition                                                  | Deduction | Rationale                                              |
| ---------------------------------------------------------- | --------- | ------------------------------------------------------ |
| Speaker change within cue without dash prefix              | -15       | Different speakers mixed without visual separation     |
| Missing dash prefix when multiple speakers in cue          | -10       | Violates multi-speaker formatting convention           |
| Speaker name/label exceeds 10 chars                        | -3        | Long labels consume too much of the CPL budget         |
| Overlapping speakers properly formatted (both with dashes) | 0         | Correct handling                                       |
| More than 2 speakers in a single cue                       | -20       | Exceeds 2-line maximum; impossible to format correctly |

**CPL adjustment for diarized content:**

When a line starts with "- " (dash-space), the effective CPL for content evaluation is reduced by 2. When a line starts with "- Name: " format, the effective CPL is reduced by `name.length + 4`.

### 3.10 Transcription Confidence (Logprobs-Aware)

When logprob data is available (from gpt-4o-transcribe or gpt-4o-mini-transcribe with `include: ["logprobs"]`), an additional confidence metric is applied:

**Calculation:**

```
avgLogprob = mean(logprob for each token in segment)
minLogprob = min(logprob for each token in segment)
```

**Scoring rules:**

| Condition                                 | Deduction | Rationale                                   |
| ----------------------------------------- | --------- | ------------------------------------------- |
| avgLogprob > -0.5                         | 0         | High confidence transcription               |
| -2.0 <= avgLogprob <= -0.5                | -5        | Medium confidence; may contain errors       |
| avgLogprob < -2.0                         | -15       | Low confidence; likely transcription errors |
| minLogprob < -5.0 (any single token)      | -10       | At least one word is highly uncertain       |
| 3+ consecutive tokens with logprob < -2.0 | -20       | Possible hallucination sequence             |

**Note:** Confidence scoring is optional and only applied when logprob data is provided alongside the segments.

---

## 4. Aggregate Scoring

### 4.1 Per-Segment Score

```
segmentScore = max(0, 100 - sum(all deductions))
```

### 4.2 File-Level Score

```
fileScore = weightedAverage(segmentScores)
```

Where weight is proportional to segment duration (longer segments have more visual impact):

```
weight(segment) = segment.duration / totalDuration
```

### 4.3 File-Level Penalty Multipliers

Additional file-level penalties are applied as multiplier factors:

| Condition                                                 | Multiplier | Rationale                             |
| --------------------------------------------------------- | ---------- | ------------------------------------- |
| >20% of segments have CPS violations                      | 0.95       | Systemic reading speed issue          |
| >10% of segments have CPL violations                      | 0.95       | Systemic line length issue            |
| >5% of segments have overlap                              | 0.90       | Systemic timing issue                 |
| Any segment scores below 40                               | 0.95       | At least one critical failure         |
| >50% of 2-line segments have bad breaks                   | 0.90       | Systemic line breaking issue          |
| >10% of segments have low confidence (avg logprob < -2.0) | 0.90       | Systemic transcription quality issue  |
| >20% of multi-speaker cues lack proper attribution        | 0.90       | Systemic diarization formatting issue |

```
finalScore = fileScore * product(applicable multipliers)
```

---

## 5. Quality Report Output

The scoring system produces a structured report:

```typescript
interface SubtitleQualityReport {
  // Overall
  overallScore: number; // 0-100
  qualityLevel: string; // "Excellent" | "Good" | "Fair" | "Poor" | "Failing"
  totalSegments: number;
  totalDuration: number; // seconds

  // Category summaries
  categories: {
    readingSpeed: {
      averageCPS: number;
      maxCPS: number;
      violationCount: number; // segments exceeding target CPS
      violationPercentage: number;
    };
    lineLength: {
      maxCPL: number;
      violationCount: number;
      violationPercentage: number;
    };
    lineCount: {
      violationCount: number; // segments with >2 lines
    };
    duration: {
      tooShort: number; // segments below min duration
      tooLong: number; // segments above max duration
      averageDuration: number;
    };
    lineBreaking: {
      badBreakCount: number;
      badBreakPercentage: number; // of multi-line segments
    };
    lineBalance: {
      averageRatio: number;
      poorBalanceCount: number;
    };
    gaps: {
      overlapCount: number;
      noGapCount: number;
      tooSmallGapCount: number;
    };
    // Optional: only present when diarization data provided
    speakerAttribution?: {
      totalSpeakerChanges: number;
      missingAttributionCount: number;
      missingAttributionPercentage: number;
    };
    // Optional: only present when logprob data provided
    confidence?: {
      averageLogprob: number;
      lowConfidenceSegments: number;
      lowConfidencePercentage: number;
      possibleHallucinationCount: number;
    };
  };

  // Per-segment details (optional, for debugging)
  segments?: SegmentScore[];
}

interface SegmentScore {
  index: number;
  start: number;
  end: number;
  text: string;
  score: number;
  violations: Violation[];
}

interface Violation {
  category: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  deduction: number;
}
```

---

## 6. Usage Scenarios

### 6.1 CI/CD Quality Gate

Run the scoring system on generated subtitles as part of automated testing:

```
if (report.overallScore < 70) {
  // Flag for manual review
}
if (report.overallScore < 50) {
  // Reject and regenerate
}
```

### 6.2 A/B Comparison

Compare two optimization strategies by scoring the same source text with each:

```
const scoreA = evaluateSubtitles(segmentsStrategyA, 'en');
const scoreB = evaluateSubtitles(segmentsStrategyB, 'en');
// Choose the strategy with the higher overall score
```

### 6.3 Regression Testing

Maintain a test corpus of subtitle files with known scores. After code changes, re-score and verify that quality has not degraded.

### 6.4 Live Monitoring

Score subtitles as they are generated and log quality metrics for monitoring dashboards.

---

## 7. Metric Weights and Customization

The default deduction values can be customized for different use cases:

| Use Case                        | Adjust                                            |
| ------------------------------- | ------------------------------------------------- |
| Broadcast (BBC compliance)      | Stricter CPL (37), stricter CPS (12-14)           |
| Streaming (Netflix compliance)  | Standard CPL (42), more lenient CPS (20)          |
| Social media / short-form       | More lenient on all metrics, shorter max duration |
| Accessibility / hard-of-hearing | Stricter CPS, prefer verbatim over condensed      |
| Children's content              | Stricter CPS (17), simpler vocabulary             |

---

## 8. Relationship to SubER Metric

The academic SubER (Subtitle Edit Rate) metric evaluates subtitle quality differently, focusing on edit distance between generated and reference subtitles. Our scoring system is complementary:

- **SubER:** Measures accuracy compared to a reference (requires ground truth)
- **Our system:** Measures compliance with formatting and readability standards (no reference needed)

Both can be used together for comprehensive quality assessment.

---

## 9. Model-Specific Quality Considerations

### 9.1 Quality Expectations by Model

| Model                             | Expected CPS Issues                         | Expected Line Break Issues       | Confidence Data        | Diarization |
| --------------------------------- | ------------------------------------------- | -------------------------------- | ---------------------- | ----------- |
| whisper-1                         | Low (pre-segmented VTT)                     | Medium (VTT segments pre-broken) | Not available          | No          |
| gpt-4o-transcribe                 | Medium (JSON-only, needs full segmentation) | High (no pre-segmentation)       | Available via logprobs | No          |
| gpt-4o-mini-transcribe            | Medium-High (faster, less accurate)         | High (no pre-segmentation)       | Available via logprobs | No          |
| gpt-4o-mini-transcribe-2025-12-15 | Medium (89% fewer hallucinations)           | High (no pre-segmentation)       | Available via logprobs | No          |
| gpt-4o-transcribe-diarize         | Medium (JSON-only)                          | High (no pre-segmentation)       | Not available          | Yes         |

### 9.2 Recommended Quality Thresholds by Model

For CI/CD quality gates, different thresholds may be appropriate depending on the model used:

| Model                             | Flag for Review | Reject and Regenerate |
| --------------------------------- | --------------- | --------------------- |
| whisper-1                         | < 75            | < 55                  |
| gpt-4o-transcribe                 | < 70            | < 50                  |
| gpt-4o-mini-transcribe            | < 65            | < 45                  |
| gpt-4o-mini-transcribe-2025-12-15 | < 70            | < 50                  |
| gpt-4o-transcribe-diarize         | < 65            | < 45                  |

The JSON-only models have lower thresholds because the formatting pipeline is doing more work and perfection is harder without pre-segmented input. As the formatting pipeline improves (especially with linguistic line breaking), these thresholds should be raised.
