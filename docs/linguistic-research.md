# Linguistic Research: Subtitle Quality Standards and Improvement Recommendations

## 1. Industry Standards Overview

### 1.1 Reading Speed Standards

| Standard                     | Reading Speed        | Notes                                                                 |
| ---------------------------- | -------------------- | --------------------------------------------------------------------- |
| BBC (broadcast, live)        | 160-180 WPM          | Updated from previous 130-150 WPM                                     |
| BBC (general rule)           | 12-14 CPS            | Approximately 180 WPM                                                 |
| Netflix (adult content)      | Up to 20 CPS         | Higher ceiling for adult viewers                                      |
| Netflix (children's content) | Up to 17 CPS         | Slower for younger audiences                                          |
| EBU / General industry       | 12 CPS               | The "six-second rule": full two-line subtitle displayed for 6 seconds |
| Academic consensus           | 140-150 WPM / 12 CPS | Based on the six-second rule                                          |

**Current implementation:** `CHARS_PER_SECOND = 12` -- This aligns with the EBU standard and the six-second rule but is conservative relative to Netflix adult standards (20 CPS). The current value is appropriate as a safe default.

### 1.2 Characters Per Line

| Standard                       | Max CPL             | Notes                                      |
| ------------------------------ | ------------------- | ------------------------------------------ |
| BBC (Teletext/broadcast)       | 37                  | Monospaced characters, Teletext constraint |
| BBC (online, 16:9)             | ~68% of video width | Not a fixed character count                |
| Netflix (most Latin languages) | 42                  | Recommended, not always enforced via QC    |
| Netflix (Korean, CJK)          | 16-23               | 16 for Originals, 23 for standard          |
| Netflix (Arabic)               | 42-50               | 42 for Originals, 50 for standard          |
| General industry range         | 32-42               | Varies by context                          |

**Current implementation:** `MAX_CHARS_PER_LINE = 42` -- Matches the Netflix standard for Latin-script languages. However, there is no language-specific adaptation. CJK content using 42 CPL would be far too wide.

### 1.3 Duration Constraints

| Standard               | Min Duration                            | Max Duration          | Notes                                         |
| ---------------------- | --------------------------------------- | --------------------- | --------------------------------------------- |
| BBC                    | ~0.3s per word (e.g., 1.2s for 4 words) | Not explicitly stated | Duration proportional to word count           |
| Netflix                | 5/6 second (~0.83s)                     | 7 seconds             | 20 frames at 24fps for minimum                |
| Current implementation | 1.5 seconds                             | 7.0 seconds           | MIN_DURATION used in optimizeSegmentDurations |
| Merge threshold        | 1.0 seconds                             | N/A                   | MIN_DURATION used in mergeShortSegments       |

**Analysis:** The current MIN_DURATION of 1.5s is more conservative than Netflix's 5/6 second minimum, which is appropriate for readability. However, there is an inconsistency: `optimizeSegmentDurations` uses `MIN_DURATION = 1.5` while `mergeShortSegments` uses `MIN_DURATION = 1.0`. These should be unified or the rationale for the difference should be documented.

### 1.4 Line Count

| Standard               | Max Lines                          | Notes                          |
| ---------------------- | ---------------------------------- | ------------------------------ |
| BBC                    | 2 (3 if picture info not obscured) | 2 is the strong recommendation |
| Netflix                | 2                                  | Firm requirement               |
| Current implementation | 2                                  | Via limitSegmentLines          |

**Current implementation:** `MAX_LINES = 2` (implicit in `limitSegmentLines`) -- Correctly aligned with all major standards.

### 1.5 Gap Between Subtitles

| Standard               | Minimum Gap               | Notes                                            |
| ---------------------- | ------------------------- | ------------------------------------------------ |
| Netflix                | 2 frames (~83ms at 24fps) | Gaps of 3-11 frames should be closed to 2 frames |
| BBC                    | Not explicitly specified  | Implied through synchronization rules            |
| General recommendation | 2-4 frames                | Allows the eye to register a new subtitle        |

**Current implementation:** No explicit gap enforcement between subtitles. The `mergeShortSegments` method uses a `gap < 0.3` threshold for merging, but there is no mechanism to ensure a minimum gap between sequential subtitles.

---

## 2. Analysis of Current Formatting Logic

### 2.1 Method-by-Method Analysis

#### `optimizeSegmentDurations` (line 390-476)

**What it does:**

- Adjusts segment durations based on text length and a fixed 12 CPS reading speed
- Extends previous segments if they are close together (gap < 0.5s)
- Splits segments that exceed MAX_DURATION (7s)

**Gaps identified:**

1. **No language-aware CPS:** Uses a hardcoded 12 CPS for all languages. German text, for instance, has longer average word lengths and might need more time per character, while CJK characters carry more information density.
2. **Naive splitting:** When splitting long segments, it splits purely on character count without considering linguistic boundaries. A segment could be split mid-clause or mid-phrase.
3. **No minimum gap enforcement:** After extending previous segments, there is no check to ensure a minimum gap between the extended segment and the next one.
4. **Duration calculation ignores newlines:** When text contains newlines (from merging), the character count includes newline characters, skewing the duration calculation.

#### `limitSegmentLines` (line 478-510)

**What it does:**

- Splits text into lines based on a 42-character maximum
- Limits output to 2 lines maximum
- Uses `redistributeLines` for overflow cases

**Gaps identified:**

1. **No linguistic awareness in line breaking:** Lines are broken purely at word boundaries when exceeding the character limit. There is no consideration of syntactic structure. For example, it might break between an article and its noun ("the\ndog") or between a preposition and its object.
2. **No punctuation-aware breaking:** The algorithm does not prefer breaking at commas, semicolons, or other natural pause points.
3. **No balanced line lengths:** The algorithm fills the first line to near-maximum before wrapping, which can produce unbalanced results like a 42-character first line and a 5-character second line. Industry best practice (especially Netflix) recommends a "bottom-heavy" or balanced approach.
4. **No language-specific CPL:** The 42-character limit is hardcoded regardless of language.
5. **Text truncation risk:** When `redistributeLines` produces more than 2 lines, it concatenates the overflow onto the second-to-last line, which can exceed the 42-character limit.

#### `redistributeLines` (line 519-539)

**What it does:**

- Re-wraps all words into lines respecting the 42-character limit
- If still more than 2 lines, joins the last line onto the second-to-last

**Gaps identified:**

1. **Overflow concatenation can exceed CPL:** Joining `newLines[newLines.length - 2] += ' ' + newLines.pop()` can create a line well beyond 42 characters.
2. **Same linguistic blindness as `limitSegmentLines`:** No clause or phrase awareness.

#### `mergeShortSegments` (line 541-568)

**What it does:**

- Merges segments shorter than 1.0s if the gap between them is less than 0.3s
- Joins text with newline separator

**Gaps identified:**

1. **Different MIN_DURATION than optimizeSegmentDurations:** Uses 1.0s vs 1.5s, which could be confusing.
2. **No check on merged result:** After merging, the resulting segment could exceed MAX_DURATION or have too many lines. There is no validation pass after merging.
3. **Merging without punctuation check:** Two segments merged together might not form a coherent linguistic unit. For example, merging the end of one sentence with the beginning of another could confuse readers.

#### `optimizeSegments` (line 512-517)

**What it does:**

- Pipeline: `optimizeSegmentDurations` -> `mergeShortSegments` -> `limitSegmentLines`

**Gap identified:**

- **Order of operations may not be optimal.** Limiting lines after merging means merges could create 3+ line segments that then get truncated. It might be better to check line limits as part of the merge decision.
- **No final validation pass:** After the pipeline completes, there is no check that all segments comply with all constraints simultaneously (duration, CPS, CPL, line count, minimum gap).

### 2.2 Pipeline Order Issues

The current pipeline order is:

1. Optimize durations (adjust timing, split long segments)
2. Merge short segments (combine brief segments)
3. Limit lines (enforce 2-line maximum, wrap long text)

A more robust order would be:

1. Optimize durations (adjust timing)
2. **Smart split long segments** (split at linguistic boundaries)
3. Merge short segments (with validation that merged result is still valid)
4. **Linguistically-aware line breaking** (break at clause/phrase boundaries)
5. **Final validation pass** (check all constraints: CPS, CPL, line count, duration, gaps)

---

## 3. Smart Line Breaking Recommendations

### 3.1 Linguistic Hierarchy for Line Breaks

Line breaks should be placed at the highest available linguistic boundary level. From most preferred to least preferred:

1. **Sentence boundary** (period, question mark, exclamation mark)
2. **Independent clause boundary** (before coordinating conjunctions: and, but, or, nor, for, yet, so)
3. **Dependent clause boundary** (before subordinating conjunctions: because, although, when, while, if, since, after, before)
4. **Major phrase boundary** (between subject and predicate, between verb phrase and object/complement)
5. **Prepositional phrase boundary** (before prepositions: in, on, at, with, for, to, from, by, about)
6. **Adverbial phrase boundary** (before adverbs modifying the clause)
7. **Word boundary** (anywhere between words -- current behavior)

### 3.2 Structures That Must NOT Be Split

The following should never be broken across lines:

- **Article + noun:** "the / dog" is bad
- **Adjective + noun:** "beautiful / sunset" is bad
- **First name + last name:** "John / Smith" is bad
- **Auxiliary + main verb:** "has / been" is bad
- **Negation + verb:** "didn't / go" is bad
- **Verb + particle (phrasal verbs):** "pick / up" is bad
- **Preposition + object:** "with / her" is bad
- **Compound numbers:** "twenty / three" is bad
- **Reflexive pronoun + verb:** "herself / prepared" is bad

### 3.3 Implementation Approach

A practical approach without requiring a full NLP parser:

```
function findBestBreakPoint(words: string[], maxCharsPerLine: number): number {
  // Score each possible break position
  // Higher score = better break point

  for each position between words:
    score = 0

    // Prefer breaking after punctuation
    if (wordBefore ends with ',', ';', ':')  score += 10
    if (wordBefore ends with '.', '!', '?')  score += 15

    // Prefer breaking before conjunctions
    if (wordAfter is conjunction)  score += 8

    // Prefer breaking before prepositions
    if (wordAfter is preposition)  score += 6

    // Penalize splitting article + noun
    if (wordBefore is article)  score -= 20

    // Penalize splitting adjective + noun (heuristic: short word before capitalized or common noun)
    if (wordBefore is common adjective)  score -= 15

    // Prefer balanced line lengths
    balancePenalty = |line1Length - line2Length| * 0.5
    score -= balancePenalty

  return position with highest score
```

### 3.4 Balanced Line Distribution

Industry best practice recommends either balanced lines or "bottom-heavy" distribution:

**Preferred (bottom-heavy for Netflix):**

```
I told him
that we should leave immediately
```

**Acceptable (balanced):**

```
I told him that we
should leave immediately
```

**Avoid (top-heavy, current behavior):**

```
I told him that we should leave
immediately
```

---

## 4. Punctuation-Aware Segmentation

### 4.1 Current Gap

The current code treats all text as a flat sequence of words. Punctuation is not used as a signal for segment boundaries or line breaks.

### 4.2 Recommendations

1. **Prefer segment boundaries at sentence endings:** When splitting long segments, prefer splitting after `.`, `?`, `!`, or `...`
2. **Use commas as secondary break points:** Commas indicate natural pauses and are good line break candidates.
3. **Respect quotation marks:** Do not split a quoted phrase across segments or lines if avoidable.
4. **Handle ellipsis correctly:** `...` at the end of a segment indicates continuation; the next segment should not start with a capital letter unless it is a proper noun.
5. **Dash handling:** Em-dashes (`--`) indicate interruptions and are acceptable break points. En-dashes in ranges (`1-10`) should not be broken.

---

## 5. Reading Speed Calibration Per Language

### 5.1 Research Summary

Research shows reading speeds differ significantly across languages:

| Language | Avg Reading Speed (WPM) | Suggested CPS | Notes                                                      |
| -------- | ----------------------- | ------------- | ---------------------------------------------------------- |
| English  | 228 WPM                 | 15-17 CPS     | Moderate word length                                       |
| German   | 179 WPM                 | 20-21 CPS     | Longer words = more chars for same WPM                     |
| Spanish  | 218 WPM                 | 16-18 CPS     | Similar to English                                         |
| French   | 214 WPM                 | 16-18 CPS     | Similar to English                                         |
| Italian  | 188 WPM                 | 15-17 CPS     | Slightly slower                                            |
| Arabic   | 138 WPM                 | 10-12 CPS     | RTL, partial vowels                                        |
| Chinese  | 158 WPM                 | 5-7 CPS       | Character-based, each character = ~2-3 Latin chars of info |
| Japanese | ~150 WPM                | 4-6 CPS       | Mixed character systems                                    |
| Korean   | ~160 WPM                | 5-7 CPS       | Syllabic blocks carry more info                            |
| Finnish  | 161 WPM                 | 12-14 CPS     | Agglutinative, long words                                  |

### 5.2 Recommendation

Replace the hardcoded `CHARS_PER_SECOND = 12` with a language-aware lookup:

```typescript
const READING_SPEED_CPS: Record<string, number> = {
  en: 15, // English
  de: 20, // German (longer words)
  es: 17, // Spanish
  fr: 17, // French
  it: 16, // Italian
  pt: 17, // Portuguese
  nl: 18, // Dutch
  sv: 17, // Swedish
  no: 17, // Norwegian
  da: 17, // Danish
  fi: 14, // Finnish
  ar: 11, // Arabic
  zh: 6, // Chinese
  ja: 5, // Japanese
  ko: 6, // Korean
  ru: 16, // Russian
  pl: 15, // Polish
  tr: 15, // Turkish
  hi: 12, // Hindi
  th: 10 // Thai (no spaces between words)
};

const DEFAULT_CPS = 12; // Fallback for unlisted languages
```

Similarly, CPL limits should be language-aware:

```typescript
const MAX_CHARS_PER_LINE: Record<string, number> = {
  default: 42,
  zh: 16, // Chinese
  ja: 16, // Japanese
  ko: 16, // Korean
  ar: 42, // Arabic
  th: 35 // Thai
};
```

---

## 6. Subtitle Condensation

### 6.1 When Condensation Is Needed

When speech rate exceeds the target reading speed, subtitle text must be condensed without losing essential meaning. This is common for:

- Fast-paced dialogue
- Technical or dense speech
- Overlapping speakers

### 6.2 Condensation Strategies (Priority Order)

1. **Remove filler words:** "um", "uh", "you know", "I mean", "like", "basically", "actually", "literally"
2. **Remove redundant discourse markers:** "well", "so", "right", "okay" when not semantically important
3. **Contract where possible:** "it is" -> "it's", "do not" -> "don't"
4. **Simplify wordy phrases:**
   - "at this point in time" -> "now"
   - "in order to" -> "to"
   - "due to the fact that" -> "because"
   - "a large number of" -> "many"
5. **Remove repetitions:** When a speaker repeats themselves, keep only the clearest version
6. **Reduce subordinate clauses:** Simplify complex sentences while preserving core meaning

### 6.3 Implementation Note

Condensation at the level described above would benefit from LLM-based post-processing (which the codebase already supports via `postProcessingPrompt`). A simpler rule-based approach can handle items 1-3 above (filler word removal, discourse marker removal, contractions).

---

## 7. Handling Special Text Elements

### 7.1 Numbers

- **Spell out numbers 1-10:** "three" not "3" (per BBC guidelines)
- **Use digits for 11+:** "42" not "forty-two"
- **Keep digit form for:** times (3:00), dates (15 March), addresses (42 High Street), channel numbers, telephone numbers
- **Large numbers with commas:** "1,000,000" not "1000000"
- **Currency before number:** "$50" not "50 dollars" (saves characters)

### 7.2 Abbreviations

- **Do not split abbreviations across lines:** "U.S.A." must stay on one line
- **Common abbreviations acceptable:** Dr., Mr., Mrs., etc., vs., e.g., i.e.
- **Expand uncommon abbreviations** on first use if space permits

### 7.3 Proper Nouns

- **Do not split names across lines** (first + last name must stay together)
- **Place names, organization names:** Keep together as a unit
- **Consider pre-populating prompt context** with proper nouns expected in the content

---

## 8. Multi-Language Considerations

### 8.1 CJK Languages (Chinese, Japanese, Korean)

- **No spaces between words** (Chinese, Japanese) or different spacing rules (Korean)
- **Character limits much lower:** 16-23 characters per line
- **Reading speed in characters is much lower** but information per character is much higher
- **Line breaking rules:** Can break between any two characters in Chinese/Japanese (except for punctuation rules). Korean has word-spacing but can break within words at syllable boundaries.
- **Punctuation:** Full-width punctuation characters (U+3000 block) take a full character width
- **Vertical text:** Japanese subtitles may use vertical orientation (Netflix supports this)

### 8.2 RTL Languages (Arabic, Hebrew)

- **Right-to-left base direction** must be properly set in output format
- **Bidirectional text:** When Latin words/numbers appear in Arabic/Hebrew text, proper bidi handling is required
- **Character counting:** Arabic characters connect and may appear narrower or wider depending on position; character count does not map 1:1 to visual width
- **Line breaking:** Must not break within a word; Arabic words are single connected units
- **Diacritics:** Arabic/Hebrew diacritics (vowel marks) should not count as separate characters for CPL purposes

### 8.3 Indic Scripts (Hindi, Bengali, Tamil, etc.)

- **Conjunct characters:** Multiple consonants can form a single visual unit (ligature)
- **Character counting complexity:** A visual "character" may be multiple Unicode code points
- **Line breaking:** Must not break within a conjunct or between a consonant and its dependent vowel sign

### 8.4 Thai

- **No spaces between words:** Word segmentation requires a dictionary or ML model
- **Spaces indicate clause/sentence boundaries,** not word boundaries
- **Character counting:** Thai characters include combining marks that should not be counted separately

### 8.5 Language-Specific Constants Summary

| Language              | Max CPL | CPS | Min Duration | Max Duration | Max Lines |
| --------------------- | ------- | --- | ------------ | ------------ | --------- |
| English               | 42      | 15  | 1.0s         | 7.0s         | 2         |
| German                | 42      | 20  | 1.0s         | 7.0s         | 2         |
| French                | 42      | 17  | 1.0s         | 7.0s         | 2         |
| Spanish               | 42      | 17  | 1.0s         | 7.0s         | 2         |
| Chinese (Simplified)  | 16      | 6   | 1.0s         | 7.0s         | 2         |
| Chinese (Traditional) | 16      | 6   | 1.0s         | 7.0s         | 2         |
| Japanese              | 16      | 5   | 1.0s         | 7.0s         | 2         |
| Korean                | 16      | 6   | 1.0s         | 7.0s         | 2         |
| Arabic                | 42      | 11  | 1.0s         | 7.0s         | 2         |
| Thai                  | 35      | 10  | 1.0s         | 7.0s         | 2         |

---

## 9. Implementation Recommendations

### 9.1 Priority 1: Linguistic Line Breaking (High Impact, Moderate Effort)

**File:** `src/TranscribeService/TranscribeService.ts` - `limitSegmentLines` method

Replace the current character-count-only line breaking with a scoring-based system that considers:

- Punctuation boundaries (highest priority)
- Clause/conjunction boundaries
- Phrase boundaries
- Avoidance of splitting tightly-bound word pairs
- Line length balance (prefer bottom-heavy or balanced)

This is the single highest-impact improvement for subtitle quality.

### 9.2 Priority 2: Language-Aware Constants (High Impact, Low Effort)

**File:** New file `src/utils/language-config.ts`

Create a configuration map of language-specific constants (CPS, CPL, min/max duration). Pass the language code through the optimization pipeline.

### 9.3 Priority 3: Segment Split at Linguistic Boundaries (Medium Impact, Moderate Effort)

**File:** `src/TranscribeService/TranscribeService.ts` - `optimizeSegmentDurations` method

When splitting segments that exceed MAX_DURATION, prefer splitting at:

1. Sentence endings (`.`, `?`, `!`)
2. After commas or semicolons
3. Before conjunctions
4. At the midpoint of the word list as a fallback

### 9.4 Priority 4: Post-Pipeline Validation (Medium Impact, Low Effort)

**File:** `src/TranscribeService/TranscribeService.ts` - `optimizeSegments` method

Add a final validation pass that checks every segment against all constraints and flags or repairs violations:

- CPS within limits
- CPL within limits
- Line count <= 2
- Duration within min/max
- Minimum gap between consecutive subtitles

### 9.5 Priority 5: Unify Constants (Low Impact, Low Effort)

Move all subtitle constants to a single location. Resolve the MIN_DURATION inconsistency between `optimizeSegmentDurations` (1.5s) and `mergeShortSegments` (1.0s).

### 9.6 Priority 6: Filler Word Removal (Low-Medium Impact, Low Effort)

Add an optional filler word removal step before the optimization pipeline:

- Remove common filler words: "um", "uh", "you know", "I mean", "like" (when used as filler)
- This helps reduce CPS violations for fast speech

### 9.7 Priority 7: Minimum Gap Enforcement (Low Impact, Low Effort)

After all optimization, ensure at least 2 frames (~83ms) gap between consecutive subtitles. If subtitles overlap or have zero gap, slightly adjust the end time of the first subtitle.

---

## 10. New Model Capabilities and Linguistic Implications

### 10.1 Impact of JSON-Only Output from New Models

The new gpt-4o-\* models only return `json` or `text` output (no native SRT/VTT). This means the subtitle formatting pipeline becomes the **sole authority** on subtitle structure. Previously, whisper-1's native VTT output provided pre-segmented subtitles that were then optimized. With JSON-only models, the service must:

1. **Segment raw text into subtitle cues from scratch** -- the segmentation logic must handle sentence boundary detection, not just optimization of pre-existing segments.
2. **Assign timestamps to each cue** -- using word-level timestamps from the JSON response.
3. **Apply all formatting rules** (CPL, CPS, line breaks, duration) during this segmentation.

This elevates the importance of every recommendation in this document. The formatting pipeline is no longer a "polishing" step -- it is the **primary subtitle authoring** step.

### 10.2 Speaker Diarization (gpt-4o-transcribe-diarize)

The diarization model identifies speakers (labeled A, B, C... or by provided names). This has significant subtitle quality implications:

#### 10.2.1 Speaker Attribution Formatting

Industry standards for multi-speaker subtitles:

| Standard           | Format                          | Notes                            |
| ------------------ | ------------------------------- | -------------------------------- |
| BBC                | Color-coded text per speaker    | Primary method for broadcast     |
| Netflix            | Dash prefix: "- Speaker A text" | Used when color is not available |
| General SDH        | "[Speaker Name]: text"          | For Subtitles for the Deaf/HoH   |
| VTT/SRT (no color) | "- " prefix per speaker line    | Most common in web subtitles     |

**Recommendation for VTT/SRT output:** Use dash prefix format:

```
- John: Where are we going?
- Mary: To the park.
```

Or when names are not available:

```
- Where are we going?
- To the park.
```

#### 10.2.2 Speaker Change and Subtitle Segmentation

**Rule: Never combine different speakers in a single subtitle cue without visual separation.**

When two speakers speak in rapid succession:

- If both utterances fit in 2 lines with dash prefixes, combine into one cue
- If they do not fit, create separate cues for each speaker
- Always start a new cue on a speaker change if the current cue already has 2 lines

**Rule: Speaker changes should ideally align with subtitle cue boundaries.**

When a speaker change occurs mid-sentence (interruption), the interrupted text should end with `--` and the interrupter should start a new cue.

#### 10.2.3 CPL Impact of Speaker Attribution

Dash prefixes ("- ") consume 2 characters per line. When diarization is active, the effective CPL should be reduced:

- Standard CPL 42 becomes effective CPL 40 for dashed lines
- For named speakers ("- John: "), the name + colon + spaces consume more characters

The optimization pipeline should account for this reduced available space.

#### 10.2.4 Overlapping Speech

When speakers talk simultaneously (detected by overlapping timestamps in diarized JSON):

- Display both speakers' text simultaneously with dash prefixes
- Each speaker gets one line (within the 2-line maximum)
- If text is too long, condense the less important utterance (typically the shorter interjection)

### 10.3 Logprobs for Confidence-Based Quality Scoring

The `include: ["logprobs"]` parameter (available on gpt-4o-transcribe and gpt-4o-mini-transcribe) returns per-token log probabilities. This can be used for:

1. **Low-confidence word flagging:** Words with low logprob values are likely transcription errors. These segments should be flagged for review rather than blindly formatted.

2. **Confidence-weighted quality scoring:** The subtitle quality score can incorporate a confidence dimension:

   - High confidence (logprob > -0.5): No adjustment
   - Medium confidence (-0.5 to -2.0): Flag for review, minor score penalty
   - Low confidence (< -2.0): Strong flag, significant score penalty; consider marking with `[?]` or similar

3. **Selective condensation:** When condensation is needed (CPS too high), prefer removing low-confidence words first, as they are more likely to be transcription artifacts (fillers, false starts, hallucinations).

4. **Hallucination detection:** The gpt-4o-mini-transcribe-2025-12-15 model already reduces hallucinations by 89%, but for other models, sequences of low-confidence words may indicate hallucinated content that should be removed entirely.

### 10.4 Streaming Implications

Streaming transcription (`stream: true`) delivers text incrementally. For subtitle quality:

1. **Progressive segmentation:** Subtitles must be segmented and timed as text arrives, not after the full transcription is complete. This means the optimization pipeline needs a streaming-compatible variant.

2. **Lookahead limitation:** Without seeing future text, optimal line breaking is harder. A pragmatic approach:

   - Buffer at least one full sentence before emitting a subtitle cue
   - Use punctuation as the primary cue for when to emit
   - Accept slightly lower quality (less balanced lines) in exchange for lower latency

3. **Correction/revision:** Streaming may produce tentative text that gets revised. The subtitle system should support updating the most recent cue when a revision arrives.

### 10.5 Model-Specific Formatting Recommendations

| Model                             | Key Consideration                                                   | Recommended Pipeline Adjustment                             |
| --------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| whisper-1                         | Native VTT output available; word-level timestamps via verbose_json | Use existing pipeline (optimize pre-segmented VTT)          |
| gpt-4o-transcribe                 | JSON only; higher accuracy                                          | Full segmentation from JSON; use logprobs for confidence    |
| gpt-4o-mini-transcribe            | JSON only; faster but less accurate                                 | Full segmentation from JSON; more aggressive validation     |
| gpt-4o-mini-transcribe-2025-12-15 | 89% fewer hallucinations                                            | Can trust text more; still use full segmentation pipeline   |
| gpt-4o-transcribe-diarize         | Speaker labels in JSON                                              | Apply speaker attribution formatting; adjust CPL for dashes |

---

## 11. Updated Implementation Priority (Revised)

Given the new model capabilities, the priority order is revised:

### 11.1 Priority 1: Full Segmentation Pipeline for JSON-Only Models (Critical)

Since new models output JSON only, the service needs a complete text-to-subtitle segmentation pipeline (not just VTT optimization). This pipeline should incorporate all linguistic rules from Sections 3-8.

### 11.2 Priority 2: Linguistic Line Breaking (High Impact)

Same as original Priority 1. Even more critical now that the service is the sole formatting authority.

### 11.3 Priority 3: Speaker Diarization Formatting (High Impact, New)

Add speaker attribution formatting (dash prefixes, speaker labels) with adjusted CPL calculations when diarization data is present.

### 11.4 Priority 4: Language-Aware Constants (High Impact, Low Effort)

Same as original Priority 2.

### 11.5 Priority 5: Logprobs-Based Confidence Scoring (Medium Impact, New)

Integrate logprobs into the quality scoring system to flag low-confidence segments and guide condensation decisions.

### 11.6 Priority 6: Segment Split at Linguistic Boundaries (Medium Impact)

Same as original Priority 3.

### 11.7 Priority 7: Post-Pipeline Validation (Medium Impact)

Same as original Priority 4. Now also validates speaker attribution formatting.

### 11.8 Priority 8: Streaming-Compatible Segmentation (Medium Impact, New)

Design a variant of the segmentation pipeline that works with incremental text delivery.

### 11.9 Priority 9: Unify Constants + Filler Word Removal + Gap Enforcement

Same as original Priorities 5-7. These remain low-effort improvements.

---

## 12. References

- BBC Subtitle Guidelines v1.2.3 (June 2024)
- Netflix Timed Text Style Guide - General Requirements
- Netflix Timed Text Style Guide - Subtitle Timing Guidelines
- Netflix Timed Text Style Guide - Language-Specific Guides
- EBU Tech 3264 - EBU STL Subtitle Format
- EBU-TT Part 1 (Tech 3350)
- Marin Garcia, A. (2013) "Subtitle reading speed: A new tool for its estimation"
- Szarkowska, A. et al. (2016) "Subtitle reading speeds in different languages"
- Karakanta, A. et al. (2022) "SubER: A Metric for Automatic Evaluation of Subtitle Quality"
- SUBTLE (Subtitlers' Association) - Recommended Quality Criteria for Subtitling
