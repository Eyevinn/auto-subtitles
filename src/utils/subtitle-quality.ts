/**
 * Subtitle Quality Scoring System
 *
 * Evaluates subtitle quality against industry standards (BBC, Netflix, EBU).
 * Produces per-segment scores and an aggregate quality report.
 */

// --- Types ---

export type TSegment = {
  start: number;
  end: number;
  text: string;
  speaker?: string;
};

export type TTokenLogprob = {
  token: string;
  logprob: number;
};

export type TSegmentLogprobs = {
  segmentIndex: number;
  tokens: TTokenLogprob[];
};

export type ViolationSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface Violation {
  category: string;
  severity: ViolationSeverity;
  message: string;
  deduction: number;
}

export interface SegmentScore {
  index: number;
  start: number;
  end: number;
  text: string;
  score: number;
  violations: Violation[];
}

export interface CategorySummary {
  readingSpeed: {
    averageCPS: number;
    maxCPS: number;
    violationCount: number;
    violationPercentage: number;
  };
  lineLength: {
    maxCPL: number;
    violationCount: number;
    violationPercentage: number;
  };
  lineCount: {
    violationCount: number;
  };
  duration: {
    tooShort: number;
    tooLong: number;
    averageDuration: number;
  };
  lineBreaking: {
    badBreakCount: number;
    badBreakPercentage: number;
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
  speakerAttribution?: {
    totalSpeakerChanges: number;
    missingAttributionCount: number;
    missingAttributionPercentage: number;
  };
  confidence?: {
    averageLogprob: number;
    lowConfidenceSegments: number;
    lowConfidencePercentage: number;
    possibleHallucinationCount: number;
  };
}

export interface SubtitleQualityReport {
  overallScore: number;
  qualityLevel: 'Excellent' | 'Good' | 'Fair' | 'Poor' | 'Failing';
  totalSegments: number;
  totalDuration: number;
  categories: CategorySummary;
  segments: SegmentScore[];
}

// --- Language Configuration ---

const READING_SPEED_CPS: Record<string, number> = {
  en: 15,
  de: 20,
  es: 17,
  fr: 17,
  it: 16,
  pt: 17,
  nl: 18,
  sv: 17,
  no: 17,
  da: 17,
  fi: 14,
  ar: 11,
  zh: 6,
  ja: 5,
  ko: 6,
  ru: 16,
  pl: 15,
  tr: 15,
  hi: 12,
  th: 10
};

const MAX_ACCEPTABLE_CPS: Record<string, number> = {
  en: 20,
  de: 25,
  es: 22,
  fr: 22,
  it: 21,
  pt: 22,
  nl: 23,
  sv: 22,
  no: 22,
  da: 22,
  fi: 19,
  ar: 15,
  zh: 9,
  ja: 8,
  ko: 9,
  ru: 21,
  pl: 20,
  tr: 20,
  hi: 17,
  th: 14
};

const MAX_CPL: Record<string, number> = {
  default: 42,
  zh: 16,
  ja: 16,
  ko: 16,
  ar: 42,
  th: 35
};

const DEFAULT_CPS = 12;
const DEFAULT_MAX_CPS = 17;
const MIN_DURATION = 0.83; // Netflix minimum (5/6 second)
const IDEAL_MIN_DURATION = 1.0;
const MAX_DURATION = 7.0;
const MAX_LINES = 2;
const MIN_GAP_SECONDS = 0.083; // ~2 frames at 24fps

// --- Word lists for linguistic line break scoring ---

const ARTICLES = new Set([
  'a',
  'an',
  'the',
  'el',
  'la',
  'los',
  'las',
  'un',
  'una',
  'le',
  'les',
  'der',
  'die',
  'das',
  'ein',
  'eine'
]);

const CONJUNCTIONS = new Set([
  'and',
  'but',
  'or',
  'nor',
  'for',
  'yet',
  'so',
  'because',
  'although',
  'when',
  'while',
  'if',
  'since',
  'after',
  'before',
  'unless',
  'until',
  'that',
  'though',
  'whereas'
]);

const AUXILIARIES = new Set([
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'having',
  'do',
  'does',
  'did',
  'will',
  'would',
  'shall',
  'should',
  'may',
  'might',
  'can',
  'could',
  'must'
]);

const NEGATIONS = new Set([
  'not',
  "n't",
  'never',
  'no',
  "don't",
  "doesn't",
  "didn't",
  "won't",
  "wouldn't",
  "shouldn't",
  "couldn't",
  "can't",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  "hasn't",
  "haven't",
  "hadn't"
]);

// --- Utility Functions ---

function getTargetCPS(language: string): number {
  return READING_SPEED_CPS[language] ?? DEFAULT_CPS;
}

function getMaxCPS(language: string): number {
  return MAX_ACCEPTABLE_CPS[language] ?? DEFAULT_MAX_CPS;
}

function getMaxCPL(language: string): number {
  return MAX_CPL[language] ?? MAX_CPL['default'];
}

function countDisplayCharacters(text: string): number {
  // Count characters excluding newlines
  return text.replace(/\n/g, '').length;
}

function getLines(text: string): string[] {
  return text.split('\n').filter((line) => line.length > 0);
}

function getSegmentDuration(segment: TSegment): number {
  return segment.end - segment.start;
}

function getCPS(segment: TSegment): number {
  const duration = getSegmentDuration(segment);
  if (duration <= 0) return Infinity;
  return countDisplayCharacters(segment.text) / duration;
}

function cleanWord(word: string): string {
  return word.replace(/[.,!?;:'"(){}[\]]/g, '').toLowerCase();
}

// --- Scoring Functions ---

function scoreReadingSpeed(segment: TSegment, language: string): Violation[] {
  const violations: Violation[] = [];
  const cps = getCPS(segment);
  const target = getTargetCPS(language);
  const maxAcceptable = getMaxCPS(language);

  if (cps > maxAcceptable) {
    violations.push({
      category: 'readingSpeed',
      severity: 'high',
      message: `CPS ${cps.toFixed(
        1
      )} exceeds maximum acceptable ${maxAcceptable} (target: ${target})`,
      deduction: 30
    });
  } else if (cps > target + 3) {
    const excessAbove3 = cps - (target + 3);
    violations.push({
      category: 'readingSpeed',
      severity: 'medium',
      message: `CPS ${cps.toFixed(1)} is notably above target ${target}`,
      deduction: 15 + Math.floor(excessAbove3) * 10
    });
  } else if (cps > target) {
    const excess = cps - target;
    violations.push({
      category: 'readingSpeed',
      severity: 'low',
      message: `CPS ${cps.toFixed(1)} slightly exceeds target ${target}`,
      deduction: Math.ceil(excess) * 5
    });
  }

  if (cps < 3 && cps > 0) {
    violations.push({
      category: 'readingSpeed',
      severity: 'low',
      message: `CPS ${cps.toFixed(
        1
      )} is very low; subtitle displayed much longer than needed`,
      deduction: 5
    });
  }

  return violations;
}

function scoreLineLength(segment: TSegment, language: string): Violation[] {
  const violations: Violation[] = [];
  const maxCpl = getMaxCPL(language);
  const lines = getLines(segment.text);

  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i].length;
    const excess = lineLen - maxCpl;

    if (excess > 10) {
      violations.push({
        category: 'lineLength',
        severity: 'high',
        message: `Line ${
          i + 1
        } has ${lineLen} characters, exceeds limit of ${maxCpl} by ${excess}`,
        deduction: 20
      });
    } else if (excess > 5) {
      violations.push({
        category: 'lineLength',
        severity: 'medium',
        message: `Line ${
          i + 1
        } has ${lineLen} characters, exceeds limit of ${maxCpl} by ${excess}`,
        deduction: 5 * (excess - 5) + 3 * 5
      });
    } else if (excess > 0) {
      violations.push({
        category: 'lineLength',
        severity: 'low',
        message: `Line ${
          i + 1
        } has ${lineLen} characters, exceeds limit of ${maxCpl} by ${excess}`,
        deduction: excess * 3
      });
    }
  }

  return violations;
}

function scoreLineCount(segment: TSegment): Violation[] {
  const violations: Violation[] = [];
  const lines = getLines(segment.text);

  if (lines.length > MAX_LINES + 1) {
    violations.push({
      category: 'lineCount',
      severity: 'critical',
      message: `Segment has ${lines.length} lines, maximum is ${MAX_LINES}`,
      deduction: 30
    });
  } else if (lines.length > MAX_LINES) {
    violations.push({
      category: 'lineCount',
      severity: 'high',
      message: `Segment has ${lines.length} lines, maximum is ${MAX_LINES}`,
      deduction: 15
    });
  }

  return violations;
}

function scoreDuration(segment: TSegment): Violation[] {
  const violations: Violation[] = [];
  const duration = getSegmentDuration(segment);

  if (duration < MIN_DURATION) {
    violations.push({
      category: 'duration',
      severity: 'high',
      message: `Duration ${duration.toFixed(
        2
      )}s is below minimum ${MIN_DURATION}s`,
      deduction: 15
    });
  } else if (duration < IDEAL_MIN_DURATION) {
    violations.push({
      category: 'duration',
      severity: 'low',
      message: `Duration ${duration.toFixed(
        2
      )}s is below ideal minimum ${IDEAL_MIN_DURATION}s`,
      deduction: 5
    });
  }

  if (duration > MAX_DURATION + 1) {
    violations.push({
      category: 'duration',
      severity: 'high',
      message: `Duration ${duration.toFixed(
        2
      )}s exceeds maximum ${MAX_DURATION}s`,
      deduction: 15
    });
  } else if (duration > MAX_DURATION) {
    violations.push({
      category: 'duration',
      severity: 'low',
      message: `Duration ${duration.toFixed(
        2
      )}s slightly exceeds maximum ${MAX_DURATION}s`,
      deduction: 5
    });
  }

  return violations;
}

function scoreLineBreaking(segment: TSegment): Violation[] {
  const violations: Violation[] = [];
  const lines = getLines(segment.text);

  if (lines.length < 2) return violations;

  for (let i = 0; i < lines.length - 1; i++) {
    const currentLine = lines[i];
    const nextLine = lines[i + 1];
    const lastWord = cleanWord(
      currentLine
        .split(' ')
        .filter((w) => w.length > 0)
        .pop() ?? ''
    );
    const firstWordNext = cleanWord(
      nextLine.split(' ').filter((w) => w.length > 0)[0] ?? ''
    );

    // Check: article at end of line (article + noun split)
    if (ARTICLES.has(lastWord)) {
      violations.push({
        category: 'lineBreaking',
        severity: 'high',
        message: `Line break splits article "${lastWord}" from its noun "${firstWordNext}"`,
        deduction: 10
      });
    }

    // Check: auxiliary at end of line
    if (AUXILIARIES.has(lastWord)) {
      violations.push({
        category: 'lineBreaking',
        severity: 'medium',
        message: `Line break splits auxiliary "${lastWord}" from verb`,
        deduction: 8
      });
    }

    // Check: negation at end of line splitting from verb
    if (NEGATIONS.has(lastWord)) {
      violations.push({
        category: 'lineBreaking',
        severity: 'high',
        message: `Line break splits negation "${lastWord}" from verb`,
        deduction: 10
      });
    }

    // Positive: break before conjunction is good
    if (CONJUNCTIONS.has(firstWordNext)) {
      // No deduction, this is a good break point
    }

    // Positive: break after punctuation is good
    if (/[,;:.\-!?]$/.test(currentLine.trim())) {
      // No deduction, this is a good break point
    }
  }

  return violations;
}

function scoreLineBalance(segment: TSegment): Violation[] {
  const violations: Violation[] = [];
  const lines = getLines(segment.text);

  if (lines.length !== 2) return violations;

  const len1 = lines[0].length;
  const len2 = lines[1].length;
  const shorter = Math.min(len1, len2);
  const longer = Math.max(len1, len2);

  if (longer === 0) return violations;

  const ratio = shorter / longer;

  if (ratio < 0.2) {
    violations.push({
      category: 'lineBalance',
      severity: 'medium',
      message: `Very unbalanced lines: ${len1} / ${len2} characters (ratio ${ratio.toFixed(
        2
      )})`,
      deduction: 10
    });
  } else if (ratio < 0.35) {
    violations.push({
      category: 'lineBalance',
      severity: 'low',
      message: `Notably unbalanced lines: ${len1} / ${len2} characters (ratio ${ratio.toFixed(
        2
      )})`,
      deduction: 6
    });
  } else if (ratio < 0.5) {
    violations.push({
      category: 'lineBalance',
      severity: 'low',
      message: `Slightly unbalanced lines: ${len1} / ${len2} characters (ratio ${ratio.toFixed(
        2
      )})`,
      deduction: 3
    });
  }

  return violations;
}

function scoreGap(current: TSegment, next: TSegment | undefined): Violation[] {
  const violations: Violation[] = [];
  if (!next) return violations;

  const gap = next.start - current.end;

  if (gap < 0) {
    violations.push({
      category: 'gap',
      severity: 'critical',
      message: `Overlap of ${(-gap).toFixed(3)}s with next segment`,
      deduction: 20
    });
  } else if (gap === 0) {
    violations.push({
      category: 'gap',
      severity: 'medium',
      message:
        'No gap between segments; viewer cannot distinguish subtitle change',
      deduction: 8
    });
  } else if (gap < MIN_GAP_SECONDS) {
    violations.push({
      category: 'gap',
      severity: 'low',
      message: `Gap of ${(gap * 1000).toFixed(0)}ms is below minimum ${(
        MIN_GAP_SECONDS * 1000
      ).toFixed(0)}ms`,
      deduction: 5
    });
  }

  return violations;
}

function scoreEmptySegment(segment: TSegment): Violation[] {
  const violations: Violation[] = [];
  if (segment.text.trim().length === 0) {
    violations.push({
      category: 'content',
      severity: 'critical',
      message: 'Segment has empty or whitespace-only text',
      deduction: 50
    });
  }
  return violations;
}

function scoreSpeakerAttribution(
  segment: TSegment,
  prevSegment: TSegment | undefined
): Violation[] {
  const violations: Violation[] = [];
  const lines = getLines(segment.text);

  // Check if this segment has a different speaker from the previous one
  const hasSpeakerChange =
    prevSegment?.speaker !== undefined &&
    segment.speaker !== undefined &&
    prevSegment.speaker !== segment.speaker;

  // Check if multiple speakers are indicated within a single cue
  // (lines starting with "- " indicate multi-speaker formatting)
  const dashedLines = lines.filter((l) => l.trimStart().startsWith('- '));
  const hasDashFormat = dashedLines.length > 0;

  // If segment has speaker metadata and multiple lines without dash formatting,
  // check if it might contain mixed speakers
  if (hasSpeakerChange && lines.length >= 2 && !hasDashFormat) {
    violations.push({
      category: 'speakerAttribution',
      severity: 'high',
      message: 'Speaker change detected but lines lack dash prefix formatting',
      deduction: 15
    });
  }

  // If there are dashed lines, check that ALL lines in multi-speaker cues have dashes
  if (hasDashFormat && dashedLines.length !== lines.length) {
    violations.push({
      category: 'speakerAttribution',
      severity: 'medium',
      message: `${dashedLines.length} of ${lines.length} lines have dash prefix; all should have it for consistency`,
      deduction: 10
    });
  }

  // Check for excessively long speaker labels
  for (const line of lines) {
    const labelMatch = line.match(/^-\s+([^:]+):\s/);
    if (labelMatch && labelMatch[1].length > 10) {
      violations.push({
        category: 'speakerAttribution',
        severity: 'low',
        message: `Speaker label "${labelMatch[1]}" exceeds 10 characters, consuming CPL budget`,
        deduction: 3
      });
    }
  }

  return violations;
}

function scoreConfidence(logprobs: TSegmentLogprobs | undefined): Violation[] {
  const violations: Violation[] = [];
  if (!logprobs || logprobs.tokens.length === 0) return violations;

  const avgLogprob =
    logprobs.tokens.reduce((sum, t) => sum + t.logprob, 0) /
    logprobs.tokens.length;
  const minLogprob = Math.min(...logprobs.tokens.map((t) => t.logprob));

  if (avgLogprob < -2.0) {
    violations.push({
      category: 'confidence',
      severity: 'high',
      message: `Low average confidence (logprob ${avgLogprob.toFixed(
        2
      )}); likely transcription errors`,
      deduction: 15
    });
  } else if (avgLogprob < -0.5) {
    violations.push({
      category: 'confidence',
      severity: 'low',
      message: `Medium confidence (logprob ${avgLogprob.toFixed(
        2
      )}); may contain errors`,
      deduction: 5
    });
  }

  if (minLogprob < -5.0) {
    const lowToken = logprobs.tokens.find((t) => t.logprob === minLogprob);
    violations.push({
      category: 'confidence',
      severity: 'high',
      message: `Token "${
        lowToken?.token
      }" has very low confidence (logprob ${minLogprob.toFixed(2)})`,
      deduction: 10
    });
  }

  // Check for consecutive low-confidence tokens (possible hallucination)
  let consecutiveLow = 0;
  let maxConsecutiveLow = 0;
  for (const token of logprobs.tokens) {
    if (token.logprob < -2.0) {
      consecutiveLow++;
      if (consecutiveLow > maxConsecutiveLow) {
        maxConsecutiveLow = consecutiveLow;
      }
    } else {
      consecutiveLow = 0;
    }
  }

  if (maxConsecutiveLow >= 3) {
    violations.push({
      category: 'confidence',
      severity: 'critical',
      message: `${maxConsecutiveLow} consecutive low-confidence tokens detected; possible hallucination`,
      deduction: 20
    });
  }

  return violations;
}

// --- Main Scoring Function ---

function scoreSegment(
  segment: TSegment,
  index: number,
  prevSegment: TSegment | undefined,
  nextSegment: TSegment | undefined,
  language: string,
  logprobs?: TSegmentLogprobs
): SegmentScore {
  const allViolations: Violation[] = [
    ...scoreEmptySegment(segment),
    ...scoreReadingSpeed(segment, language),
    ...scoreLineLength(segment, language),
    ...scoreLineCount(segment),
    ...scoreDuration(segment),
    ...scoreLineBreaking(segment),
    ...scoreLineBalance(segment),
    ...scoreGap(segment, nextSegment),
    ...scoreSpeakerAttribution(segment, prevSegment),
    ...scoreConfidence(logprobs)
  ];

  const totalDeduction = allViolations.reduce((sum, v) => sum + v.deduction, 0);
  const score = Math.max(0, 100 - totalDeduction);

  return {
    index,
    start: segment.start,
    end: segment.end,
    text: segment.text,
    score,
    violations: allViolations
  };
}

function getQualityLevel(
  score: number
): 'Excellent' | 'Good' | 'Fair' | 'Poor' | 'Failing' {
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Good';
  if (score >= 60) return 'Fair';
  if (score >= 40) return 'Poor';
  return 'Failing';
}

// --- Public API ---

/**
 * Evaluate the quality of a subtitle file.
 *
 * @param segments Array of subtitle segments with start, end, text, optional speaker
 * @param language ISO 639-1 language code (e.g., 'en', 'de', 'zh')
 * @param logprobs Optional per-segment logprob data from gpt-4o models
 * @returns A comprehensive quality report
 */
export function evaluateSubtitles(
  segments: TSegment[],
  language = 'en',
  logprobs?: TSegmentLogprobs[]
): SubtitleQualityReport {
  if (segments.length === 0) {
    return {
      overallScore: 0,
      qualityLevel: 'Failing',
      totalSegments: 0,
      totalDuration: 0,
      categories: {
        readingSpeed: {
          averageCPS: 0,
          maxCPS: 0,
          violationCount: 0,
          violationPercentage: 0
        },
        lineLength: {
          maxCPL: 0,
          violationCount: 0,
          violationPercentage: 0
        },
        lineCount: { violationCount: 0 },
        duration: { tooShort: 0, tooLong: 0, averageDuration: 0 },
        lineBreaking: { badBreakCount: 0, badBreakPercentage: 0 },
        lineBalance: { averageRatio: 0, poorBalanceCount: 0 },
        gaps: { overlapCount: 0, noGapCount: 0, tooSmallGapCount: 0 }
      },
      segments: []
    };
  }

  // Build logprobs lookup
  const logprobMap = new Map<number, TSegmentLogprobs>();
  if (logprobs) {
    for (const lp of logprobs) {
      logprobMap.set(lp.segmentIndex, lp);
    }
  }

  // Score each segment
  const segmentScores: SegmentScore[] = segments.map((seg, i) =>
    scoreSegment(
      seg,
      i,
      i > 0 ? segments[i - 1] : undefined,
      segments[i + 1],
      language,
      logprobMap.get(i)
    )
  );

  // Calculate weighted average (weight by duration)
  const totalDuration = segments.reduce(
    (sum, s) => sum + getSegmentDuration(s),
    0
  );
  let weightedSum = 0;
  for (let i = 0; i < segmentScores.length; i++) {
    const duration = getSegmentDuration(segments[i]);
    const weight =
      totalDuration > 0 ? duration / totalDuration : 1 / segments.length;
    weightedSum += segmentScores[i].score * weight;
  }

  // Compute category summaries
  let totalCPS = 0;
  let maxCPS = 0;
  let cpsViolations = 0;
  let maxCPL = 0;
  let cplViolations = 0;
  let lineCountViolations = 0;
  let tooShort = 0;
  let tooLong = 0;
  let totalSegDuration = 0;
  let badBreaks = 0;
  let multiLineSegments = 0;
  let balanceRatioSum = 0;
  let balanceCount = 0;
  let poorBalance = 0;
  let overlapCount = 0;
  let noGapCount = 0;
  let tooSmallGapCount = 0;
  let speakerChanges = 0;
  let missingAttribution = 0;
  let hasDiarization = false;
  let totalLogprob = 0;
  let logprobSegmentCount = 0;
  let lowConfidenceSegments = 0;
  let hallucinationCount = 0;
  let hasLogprobs = false;

  const targetCPS = getTargetCPS(language);

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const cps = getCPS(seg);
    const duration = getSegmentDuration(seg);
    const lines = getLines(seg.text);

    totalCPS += cps;
    if (cps > maxCPS) maxCPS = cps;
    if (cps > targetCPS) cpsViolations++;

    for (const line of lines) {
      if (line.length > maxCPL) maxCPL = line.length;
    }
    const maxLineCpl = getMaxCPL(language);
    if (lines.some((l) => l.length > maxLineCpl)) cplViolations++;

    if (lines.length > MAX_LINES) lineCountViolations++;
    if (duration < IDEAL_MIN_DURATION) tooShort++;
    if (duration > MAX_DURATION) tooLong++;
    totalSegDuration += duration;

    if (lines.length >= 2) {
      multiLineSegments++;
      const score = segmentScores[i];
      if (score.violations.some((v) => v.category === 'lineBreaking')) {
        badBreaks++;
      }
      const len1 = lines[0].length;
      const len2 = lines[1].length;
      const longer = Math.max(len1, len2);
      const shorter = Math.min(len1, len2);
      if (longer > 0) {
        const ratio = shorter / longer;
        balanceRatioSum += ratio;
        balanceCount++;
        if (ratio < 0.35) poorBalance++;
      }
    }

    // Gap analysis
    if (i < segments.length - 1) {
      const gap = segments[i + 1].start - seg.end;
      if (gap < 0) overlapCount++;
      else if (gap === 0) noGapCount++;
      else if (gap < MIN_GAP_SECONDS) tooSmallGapCount++;
    }

    // Speaker attribution analysis
    if (seg.speaker !== undefined) {
      hasDiarization = true;
      if (i > 0 && segments[i - 1].speaker !== seg.speaker) {
        speakerChanges++;
        const score = segmentScores[i];
        if (score.violations.some((v) => v.category === 'speakerAttribution')) {
          missingAttribution++;
        }
      }
    }

    // Confidence analysis
    const segLogprobs = logprobMap.get(i);
    if (segLogprobs && segLogprobs.tokens.length > 0) {
      hasLogprobs = true;
      const avgLp =
        segLogprobs.tokens.reduce((s, t) => s + t.logprob, 0) /
        segLogprobs.tokens.length;
      totalLogprob += avgLp;
      logprobSegmentCount++;
      if (avgLp < -2.0) lowConfidenceSegments++;
      const score = segmentScores[i];
      if (
        score.violations.some(
          (v) =>
            v.category === 'confidence' && v.message.includes('consecutive')
        )
      ) {
        hallucinationCount++;
      }
    }
  }

  // Apply file-level penalty multipliers
  let multiplier = 1.0;
  if (cpsViolations / segments.length > 0.2) multiplier *= 0.95;
  if (cplViolations / segments.length > 0.1) multiplier *= 0.95;
  if (overlapCount / segments.length > 0.05) multiplier *= 0.9;
  if (segmentScores.some((s) => s.score < 40)) multiplier *= 0.95;
  if (multiLineSegments > 0 && badBreaks / multiLineSegments > 0.5) {
    multiplier *= 0.9;
  }
  if (
    logprobSegmentCount > 0 &&
    lowConfidenceSegments / logprobSegmentCount > 0.1
  ) {
    multiplier *= 0.9;
  }
  if (speakerChanges > 0 && missingAttribution / speakerChanges > 0.2) {
    multiplier *= 0.9;
  }

  const finalScore = Math.max(
    0,
    Math.min(100, Math.round(weightedSum * multiplier))
  );

  const categorySummary: CategorySummary = {
    readingSpeed: {
      averageCPS: segments.length > 0 ? totalCPS / segments.length : 0,
      maxCPS,
      violationCount: cpsViolations,
      violationPercentage:
        segments.length > 0 ? (cpsViolations / segments.length) * 100 : 0
    },
    lineLength: {
      maxCPL,
      violationCount: cplViolations,
      violationPercentage:
        segments.length > 0 ? (cplViolations / segments.length) * 100 : 0
    },
    lineCount: {
      violationCount: lineCountViolations
    },
    duration: {
      tooShort,
      tooLong,
      averageDuration:
        segments.length > 0 ? totalSegDuration / segments.length : 0
    },
    lineBreaking: {
      badBreakCount: badBreaks,
      badBreakPercentage:
        multiLineSegments > 0 ? (badBreaks / multiLineSegments) * 100 : 0
    },
    lineBalance: {
      averageRatio: balanceCount > 0 ? balanceRatioSum / balanceCount : 1,
      poorBalanceCount: poorBalance
    },
    gaps: {
      overlapCount,
      noGapCount,
      tooSmallGapCount
    }
  };

  if (hasDiarization) {
    categorySummary.speakerAttribution = {
      totalSpeakerChanges: speakerChanges,
      missingAttributionCount: missingAttribution,
      missingAttributionPercentage:
        speakerChanges > 0 ? (missingAttribution / speakerChanges) * 100 : 0
    };
  }

  if (hasLogprobs) {
    categorySummary.confidence = {
      averageLogprob:
        logprobSegmentCount > 0 ? totalLogprob / logprobSegmentCount : 0,
      lowConfidenceSegments,
      lowConfidencePercentage:
        logprobSegmentCount > 0
          ? (lowConfidenceSegments / logprobSegmentCount) * 100
          : 0,
      possibleHallucinationCount: hallucinationCount
    };
  }

  return {
    overallScore: finalScore,
    qualityLevel: getQualityLevel(finalScore),
    totalSegments: segments.length,
    totalDuration,
    categories: categorySummary,
    segments: segmentScores
  };
}

/**
 * Get a concise text summary of a quality report.
 */
export function formatQualityReport(report: SubtitleQualityReport): string {
  const lines: string[] = [];
  lines.push(`Subtitle Quality Report`);
  lines.push(`=======================`);
  lines.push(
    `Overall Score: ${report.overallScore}/100 (${report.qualityLevel})`
  );
  lines.push(`Total Segments: ${report.totalSegments}`);
  lines.push(`Total Duration: ${report.totalDuration.toFixed(1)}s`);
  lines.push('');

  const cat = report.categories;
  lines.push(`Reading Speed:`);
  lines.push(`  Average CPS: ${cat.readingSpeed.averageCPS.toFixed(1)}`);
  lines.push(`  Max CPS: ${cat.readingSpeed.maxCPS.toFixed(1)}`);
  lines.push(
    `  Violations: ${
      cat.readingSpeed.violationCount
    } (${cat.readingSpeed.violationPercentage.toFixed(1)}%)`
  );

  lines.push(`Line Length:`);
  lines.push(`  Max CPL: ${cat.lineLength.maxCPL}`);
  lines.push(
    `  Violations: ${
      cat.lineLength.violationCount
    } (${cat.lineLength.violationPercentage.toFixed(1)}%)`
  );

  lines.push(`Line Count Violations: ${cat.lineCount.violationCount}`);

  lines.push(`Duration:`);
  lines.push(`  Too Short: ${cat.duration.tooShort}`);
  lines.push(`  Too Long: ${cat.duration.tooLong}`);
  lines.push(`  Average: ${cat.duration.averageDuration.toFixed(2)}s`);

  lines.push(`Line Breaking:`);
  lines.push(
    `  Bad Breaks: ${
      cat.lineBreaking.badBreakCount
    } (${cat.lineBreaking.badBreakPercentage.toFixed(1)}% of multi-line)`
  );

  lines.push(`Line Balance:`);
  lines.push(`  Average Ratio: ${cat.lineBalance.averageRatio.toFixed(2)}`);
  lines.push(`  Poor Balance Count: ${cat.lineBalance.poorBalanceCount}`);

  lines.push(`Gaps:`);
  lines.push(`  Overlaps: ${cat.gaps.overlapCount}`);
  lines.push(`  No Gap: ${cat.gaps.noGapCount}`);
  lines.push(`  Too Small Gap: ${cat.gaps.tooSmallGapCount}`);

  if (cat.speakerAttribution) {
    lines.push(`Speaker Attribution:`);
    lines.push(
      `  Speaker Changes: ${cat.speakerAttribution.totalSpeakerChanges}`
    );
    lines.push(
      `  Missing Attribution: ${
        cat.speakerAttribution.missingAttributionCount
      } (${cat.speakerAttribution.missingAttributionPercentage.toFixed(1)}%)`
    );
  }

  if (cat.confidence) {
    lines.push(`Transcription Confidence:`);
    lines.push(
      `  Average Logprob: ${cat.confidence.averageLogprob.toFixed(2)}`
    );
    lines.push(
      `  Low Confidence Segments: ${
        cat.confidence.lowConfidenceSegments
      } (${cat.confidence.lowConfidencePercentage.toFixed(1)}%)`
    );
    lines.push(
      `  Possible Hallucinations: ${cat.confidence.possibleHallucinationCount}`
    );
  }

  // Show worst segments
  const worstSegments = [...report.segments]
    .sort((a, b) => a.score - b.score)
    .slice(0, 5);

  if (worstSegments.length > 0 && worstSegments[0].score < 100) {
    lines.push('');
    lines.push(`Lowest Scoring Segments:`);
    for (const seg of worstSegments) {
      if (seg.score >= 100) break;
      const textPreview =
        seg.text.length > 50
          ? seg.text.substring(0, 50).replace(/\n/g, ' ') + '...'
          : seg.text.replace(/\n/g, ' ');
      lines.push(
        `  #${seg.index + 1} [${seg.start.toFixed(1)}s-${seg.end.toFixed(
          1
        )}s] Score: ${seg.score} "${textPreview}"`
      );
      for (const v of seg.violations) {
        lines.push(`    - [${v.severity}] ${v.message} (-${v.deduction})`);
      }
    }
  }

  return lines.join('\n');
}
