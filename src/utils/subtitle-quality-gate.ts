/**
 * Subtitle Quality Gate
 *
 * CI-friendly quality gate that evaluates subtitle segments against
 * a minimum quality threshold. Returns pass/fail with a detailed
 * report including category-level breakdowns.
 *
 * Usage in tests:
 * ```
 * const result = runQualityGate(segments, 70, 'en');
 * expect(result.pass).toBe(true);
 * ```
 *
 * Usage in CI:
 * ```
 * const result = runQualityGate(segments, 70, 'en');
 * console.log(formatGateSummary(result));
 * if (!result.pass) process.exit(1);
 * ```
 */

import {
  evaluateSubtitles,
  formatQualityReport,
  TSegment,
  TSegmentLogprobs,
  SubtitleQualityReport
} from './subtitle-quality';

export interface CategoryFailure {
  category: string;
  detail: string;
}

export interface QualityGateResult {
  /** Whether the overall score meets the threshold */
  pass: boolean;
  /** The overall quality score (0-100) */
  score: number;
  /** The threshold that was applied */
  threshold: number;
  /** Human-readable quality level */
  qualityLevel: string;
  /** Full human-readable report */
  report: string;
  /** Number of individual segments scoring below the threshold */
  segmentsBelowThreshold: number;
  /** Total number of segments evaluated */
  totalSegments: number;
  /** Category-level failures that contributed to a low score */
  categoryFailures: CategoryFailure[];
  /** The full structured report (for programmatic access) */
  fullReport: SubtitleQualityReport;
}

/**
 * Runs the quality gate on subtitle segments.
 *
 * @param segments Array of subtitle segments with start, end, text
 * @param threshold Minimum acceptable score (0-100).
 *   Recommended: 70 for CI, 80 for production, 60 for draft/preview.
 * @param language ISO 639-1 language code for language-specific evaluation
 * @param logprobs Optional logprob data for confidence scoring
 * @returns QualityGateResult with pass/fail, score, and detailed report
 */
export function runQualityGate(
  segments: TSegment[],
  threshold = 70,
  language?: string,
  logprobs?: TSegmentLogprobs[]
): QualityGateResult {
  if (segments.length === 0) {
    return {
      pass: false,
      score: 0,
      threshold,
      qualityLevel: 'Failing',
      report: 'No segments to evaluate.',
      segmentsBelowThreshold: 0,
      totalSegments: 0,
      categoryFailures: [
        { category: 'content', detail: 'No subtitle segments provided' }
      ],
      fullReport: evaluateSubtitles([], language)
    };
  }

  const evaluation = evaluateSubtitles(segments, language, logprobs);
  const report = formatQualityReport(evaluation);

  const segmentsBelowThreshold = evaluation.segments.filter(
    (s) => s.score < threshold
  ).length;

  // Identify category-level failures
  const categoryFailures: CategoryFailure[] = [];
  const cat = evaluation.categories;

  if (cat.readingSpeed.violationPercentage > 20) {
    categoryFailures.push({
      category: 'readingSpeed',
      detail: `${
        cat.readingSpeed.violationCount
      } segments (${cat.readingSpeed.violationPercentage.toFixed(
        0
      )}%) exceed target CPS; max CPS: ${cat.readingSpeed.maxCPS.toFixed(1)}`
    });
  }

  if (cat.lineLength.violationPercentage > 10) {
    categoryFailures.push({
      category: 'lineLength',
      detail: `${
        cat.lineLength.violationCount
      } segments (${cat.lineLength.violationPercentage.toFixed(
        0
      )}%) exceed CPL limit; max CPL: ${cat.lineLength.maxCPL}`
    });
  }

  if (cat.lineCount.violationCount > 0) {
    categoryFailures.push({
      category: 'lineCount',
      detail: `${cat.lineCount.violationCount} segments exceed 2-line maximum`
    });
  }

  if (cat.duration.tooShort > 0) {
    categoryFailures.push({
      category: 'duration',
      detail: `${cat.duration.tooShort} segments are too short (below minimum duration)`
    });
  }

  if (cat.duration.tooLong > 0) {
    categoryFailures.push({
      category: 'duration',
      detail: `${cat.duration.tooLong} segments are too long (above maximum duration)`
    });
  }

  if (cat.lineBreaking.badBreakPercentage > 30) {
    categoryFailures.push({
      category: 'lineBreaking',
      detail: `${
        cat.lineBreaking.badBreakCount
      } multi-line segments (${cat.lineBreaking.badBreakPercentage.toFixed(
        0
      )}%) have poor line breaks`
    });
  }

  if (cat.gaps.overlapCount > 0) {
    categoryFailures.push({
      category: 'gaps',
      detail: `${cat.gaps.overlapCount} segment overlaps detected`
    });
  }

  if (cat.gaps.noGapCount > segments.length * 0.1) {
    categoryFailures.push({
      category: 'gaps',
      detail: `${cat.gaps.noGapCount} segments have zero gap with the next subtitle`
    });
  }

  if (
    cat.speakerAttribution &&
    cat.speakerAttribution.missingAttributionPercentage > 20
  ) {
    categoryFailures.push({
      category: 'speakerAttribution',
      detail: `${
        cat.speakerAttribution.missingAttributionCount
      } speaker changes (${cat.speakerAttribution.missingAttributionPercentage.toFixed(
        0
      )}%) lack proper attribution`
    });
  }

  if (cat.confidence && cat.confidence.lowConfidencePercentage > 10) {
    categoryFailures.push({
      category: 'confidence',
      detail: `${
        cat.confidence.lowConfidenceSegments
      } segments (${cat.confidence.lowConfidencePercentage.toFixed(
        0
      )}%) have low transcription confidence`
    });
  }

  if (cat.confidence && cat.confidence.possibleHallucinationCount > 0) {
    categoryFailures.push({
      category: 'confidence',
      detail: `${cat.confidence.possibleHallucinationCount} possible hallucination sequences detected`
    });
  }

  return {
    pass: evaluation.overallScore >= threshold,
    score: evaluation.overallScore,
    threshold,
    qualityLevel: evaluation.qualityLevel,
    report,
    segmentsBelowThreshold,
    totalSegments: segments.length,
    categoryFailures,
    fullReport: evaluation
  };
}

/**
 * Formats the quality gate result as a short summary string
 * suitable for CI output or logs.
 */
export function formatGateSummary(result: QualityGateResult): string {
  const status = result.pass ? 'PASS' : 'FAIL';
  const parts = [
    `Score: ${result.score}/${result.threshold}`,
    `Level: ${result.qualityLevel}`,
    `Segments: ${result.totalSegments}`
  ];

  if (result.segmentsBelowThreshold > 0) {
    parts.push(`Below threshold: ${result.segmentsBelowThreshold}`);
  }

  let summary = `[${status}] ${parts.join(' | ')}`;

  if (result.categoryFailures.length > 0) {
    summary += '\nIssues:';
    for (const failure of result.categoryFailures) {
      summary += `\n  - [${failure.category}] ${failure.detail}`;
    }
  }

  return summary;
}

/**
 * Convenience function for use in Jest tests. Asserts that the
 * subtitle quality meets the given threshold, and if not, throws
 * an error with a detailed report.
 *
 * @param segments Subtitle segments to evaluate
 * @param threshold Minimum acceptable score
 * @param language ISO 639-1 language code
 * @throws Error with quality report if threshold is not met
 */
export function assertSubtitleQuality(
  segments: TSegment[],
  threshold = 70,
  language?: string
): void {
  const result = runQualityGate(segments, threshold, language);
  if (!result.pass) {
    throw new Error(
      `Subtitle quality gate failed:\n${formatGateSummary(result)}\n\n${
        result.report
      }`
    );
  }
}
