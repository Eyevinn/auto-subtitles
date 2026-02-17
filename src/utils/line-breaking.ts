/**
 * Smart linguistic line breaking for subtitles.
 *
 * Breaks subtitle text into lines at natural linguistic boundaries
 * rather than purely by character count. Uses a scoring system:
 *   punctuation > clause boundary > phrase boundary > avoid tightly-bound pairs
 *
 * Follows industry standards:
 * - Netflix TTSG: break after punctuation, before conjunctions/prepositions;
 *   never split article+noun, name pairs, auxiliary+verb, negation+verb.
 * - BBC Subtitle Guidelines v1.2.3: "each subtitle [should] form an
 *   integrated linguistic unit"; prefer clause boundaries.
 * - EBU: "linguistically coherent segmentation of text can significantly
 *   improve readability."
 */

import { getLanguageConfig } from './language-config';

// --- Tightly-bound word pairs that should not be split across lines ---

/** Articles that bind strongly to the NEXT word (their noun). */
const ARTICLES = new Set([
  'a',
  'an',
  'the',
  'le',
  'la',
  'les',
  'un',
  'une',
  'des', // French
  'el',
  'la',
  'los',
  'las',
  'un',
  'una',
  'unos',
  'unas', // Spanish
  'der',
  'die',
  'das',
  'ein',
  'eine',
  'einem',
  'einen',
  'einer',
  'eines', // German
  'il',
  'lo',
  'la',
  'i',
  'gli',
  'le',
  'un',
  'uno',
  'una', // Italian
  'o',
  'os',
  'um',
  'uma',
  'uns',
  'umas' // Portuguese
]);

/** Prepositions — penalized if they are the last word before a break. */
const PREPOSITIONS = new Set([
  'at',
  'by',
  'for',
  'from',
  'in',
  'into',
  'of',
  'on',
  'to',
  'with',
  'about',
  'above',
  'after',
  'before',
  'between',
  'through',
  'under',
  'over',
  'without',
  'against',
  'within',
  'along',
  'upon',
  'across',
  'toward',
  'towards',
  'among',
  'around',
  'behind',
  'beyond',
  'beside',
  'beneath',
  'outside',
  'inside',
  'throughout',
  'despite',
  'below',
  'during',
  'near',
  'past',
  'since',
  'until',
  'via'
]);

/** Auxiliaries that bind strongly to the NEXT word (their main verb). */
const AUXILIARIES = new Set([
  'am',
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
  'can',
  'could',
  'may',
  'might',
  'must'
]);

/** Negations that bind strongly to the NEXT word (their verb). */
const NEGATIONS = new Set([
  "don't",
  "doesn't",
  "didn't",
  "won't",
  "wouldn't",
  "can't",
  "couldn't",
  "shouldn't",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  "hasn't",
  "haven't",
  "hadn't",
  "mustn't",
  "needn't",
  'not',
  'never'
]);

/**
 * Conjunctions — GOOD break points when the break is placed
 * *before* the conjunction (i.e. conjunction starts the next line).
 */
const CONJUNCTIONS = new Set([
  // Coordinating
  'and',
  'but',
  'or',
  'nor',
  'so',
  'yet',
  // Subordinating
  'because',
  'although',
  'though',
  'while',
  'if',
  'when',
  'since',
  'after',
  'before',
  'unless',
  'until',
  'whereas',
  'whenever',
  'wherever',
  'whether',
  'once',
  'that',
  'which',
  'who',
  // German
  'und',
  'aber',
  'oder',
  'weil',
  'obwohl',
  'wenn',
  'dass',
  // French
  'et',
  'mais',
  'ou',
  'parce',
  'quand',
  'que',
  'qui',
  // Spanish
  'y',
  'pero',
  'porque',
  'cuando',
  'que',
  'quien',
  // Italian
  'e',
  'ma',
  'perché'
]);

/**
 * Common determiners and short adjectives that bind to the NEXT word.
 * Splitting "my / dog" or "this / house" reads poorly.
 */
const DETERMINERS_AND_SHORT_ADJECTIVES = new Set([
  // Possessive determiners
  'my',
  'his',
  'her',
  'its',
  'our',
  'your',
  'their',
  // Demonstratives
  'this',
  'that',
  'these',
  'those',
  // Quantifiers
  'each',
  'every',
  'both',
  'all',
  'some',
  'any',
  'no',
  'few',
  'many',
  'much',
  'more',
  'most',
  'such',
  // Common short adjectives that almost always precede a noun
  'own',
  'other',
  'same',
  'whole',
  'entire',
  'full',
  'big',
  'old',
  'new',
  'good',
  'bad',
  'long',
  'great',
  'little',
  'first',
  'last',
  'next',
  'real'
]);

/** Phrasal verb particles that bind to the PREVIOUS word (their verb). */
const PARTICLES = new Set([
  'up',
  'out',
  'off',
  'down',
  'away',
  'back',
  'over',
  'through',
  'along',
  'around',
  'about'
]);

// --- Scoring ---

/**
 * Scores a potential line break between words[i] (end of line 1)
 * and words[i+1] (start of line 2). Higher score = better break.
 */
function scoreBreakPoint(
  words: string[],
  i: number,
  totalTextLength: number
): number {
  const rawBefore = words[i];
  const rawAfter = words[i + 1] ?? '';
  const wordBefore = rawBefore
    .replace(/[.,!?;:'"(){}\u2014\u2013[\]]/g, '')
    .toLowerCase();
  const wordAfter = rawAfter
    .replace(/[.,!?;:'"(){}\u2014\u2013[\]]/g, '')
    .toLowerCase();

  let score = 0;

  // --- Positive signals: prefer breaking here ---

  // Strong: break after sentence-ending punctuation
  if (/[.!?]$/.test(rawBefore) || rawBefore.endsWith('...')) {
    score += 100;
  }

  // Good: break after clause-ending punctuation (comma, semicolon, colon)
  if (/[,;:]$/.test(rawBefore)) {
    score += 60;
  }

  // Good: break after closing quotes / parentheses
  if (/["\u201D)\]]$/.test(rawBefore)) {
    score += 50;
  }

  // Good: break before a conjunction (natural clause boundary)
  if (CONJUNCTIONS.has(wordAfter)) {
    score += 40;
  }

  // Moderate: break after a dash (em-dash, en-dash)
  if (/[-\u2013\u2014]$/.test(rawBefore) || rawBefore.endsWith('--')) {
    score += 35;
  }

  // Mild: break before a preposition (phrase boundary)
  if (PREPOSITIONS.has(wordAfter)) {
    score += 15;
  }

  // --- Negative signals: avoid breaking here ---

  // Severe: don't split article from noun
  if (ARTICLES.has(wordBefore)) {
    score -= 50;
  }

  // Severe: don't split negation from verb
  if (NEGATIONS.has(wordBefore)) {
    score -= 45;
  }

  // Severe: don't split preposition from its object
  if (PREPOSITIONS.has(wordBefore)) {
    score -= 40;
  }

  // Bad: don't split auxiliary from main verb
  if (AUXILIARIES.has(wordBefore)) {
    score -= 35;
  }

  // Bad: don't split determiner/short adjective from noun
  if (DETERMINERS_AND_SHORT_ADJECTIVES.has(wordBefore)) {
    score -= 30;
  }

  // Bad: don't split verb from particle (phrasal verb: "pick up")
  if (
    PARTICLES.has(wordAfter) &&
    !ARTICLES.has(wordBefore) &&
    !PREPOSITIONS.has(wordBefore) &&
    !CONJUNCTIONS.has(wordBefore)
  ) {
    score -= 25;
  }

  // --- Balance: prefer balanced or bottom-heavy lines ---
  // Netflix style prefers bottom-heavy (line2 slightly longer).
  const leftLength = words.slice(0, i + 1).join(' ').length;
  const balance = 1 - Math.abs(leftLength / totalTextLength - 0.5) * 2;
  score += balance * 15;

  // Slight bonus for bottom-heavy layout
  if (leftLength < totalTextLength - leftLength) {
    score += 2;
  }

  return score;
}

// --- CJK support ---

/** Characters that must not start a line (closing punct, periods, commas). */
const CJK_NO_START = new Set('）」』】〉》。、，！？；：.!?,;:)>}]．，');

/** Characters that must not end a line (opening punct). */
const CJK_NO_END = new Set('（「『【〈《(<{[');

function isCJK(text: string): boolean {
  return /[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u3400-\u4DBF]/.test(text);
}

/**
 * Breaks CJK text at character boundaries, respecting punctuation
 * placement rules and preferring balanced or bottom-heavy lines.
 */
function breakCJKLines(text: string, maxCPL: number): string[] {
  if (text.length <= maxCPL) {
    return [text];
  }

  const targetBreak = Math.floor(text.length / 2);
  let bestPos = targetBreak;
  let bestDistance = Infinity;

  const searchRange = Math.min(10, Math.floor(text.length / 4));
  const lo = Math.max(1, targetBreak - searchRange);
  const hi = Math.min(text.length - 1, targetBreak + searchRange);

  for (let i = lo; i <= hi; i++) {
    // Respect CJK punctuation constraints
    if (CJK_NO_START.has(text[i])) continue;
    if (CJK_NO_END.has(text[i - 1])) continue;

    // Both halves must fit
    if (i > maxCPL || text.length - i > maxCPL) continue;

    const distance = Math.abs(i - targetBreak);
    // Tie-break: prefer bottom-heavy (slightly after midpoint)
    const adjusted = i >= targetBreak ? distance : distance + 0.5;
    if (adjusted < bestDistance) {
      bestDistance = adjusted;
      bestPos = i;
    }
  }

  const line1 = text.slice(0, bestPos);
  const line2 = text.slice(bestPos);

  if (line1.length > maxCPL) {
    return [text.slice(0, maxCPL), text.slice(maxCPL, maxCPL * 2)].filter(
      Boolean
    );
  }

  return [line1, line2].filter(Boolean);
}

// --- Fallback ---

/**
 * Fallback character-count-based break when no linguistically valid
 * break fits within CPL constraints.
 */
function fallbackBreak(words: string[], maxCPL: number): string[] {
  let line1 = '';
  let breakIdx = 0;

  for (let i = 0; i < words.length; i++) {
    const candidate = line1 ? line1 + ' ' + words[i] : words[i];
    if (candidate.length > maxCPL && line1.length > 0) {
      breakIdx = i;
      break;
    }
    line1 = candidate;
    breakIdx = i + 1;
  }

  const l1 = words.slice(0, breakIdx).join(' ');
  const l2 = words.slice(breakIdx).join(' ');

  if (l2.length === 0) return [l1];
  return [l1, l2];
}

// --- Public API ---

/**
 * Finds the optimal line break for subtitle text.
 *
 * Returns an array of lines (max 2) broken at the best linguistic
 * boundary. If text fits on one line, returns a single-element array.
 *
 * @param text Subtitle text (may contain existing newlines, which are
 *   treated as spaces for re-breaking)
 * @param maxCharsPerLine Maximum characters per line. If not provided,
 *   uses the language default from language-config.
 * @param language ISO 639-1 language code. Used to determine the
 *   default CPL and to select CJK-specific breaking behavior.
 * @returns Array of 1 or 2 lines
 */
export function findOptimalLineBreak(
  text: string,
  maxCharsPerLine?: number,
  language?: string
): string[] {
  const config = getLanguageConfig(language);
  const maxCPL = maxCharsPerLine ?? config.cpl;

  // Normalize: replace newlines with spaces, collapse whitespace, trim
  const normalized = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

  // If it fits on one line, no break needed
  if (normalized.length <= maxCPL) {
    return [normalized];
  }

  // CJK text needs character-based breaking
  if (config.scriptType === 'cjk' || isCJK(normalized)) {
    return breakCJKLines(normalized, maxCPL);
  }

  const words = normalized.split(' ').filter((w) => w.length > 0);

  // Single word exceeding CPL — cannot break linguistically
  if (words.length <= 1) {
    return [normalized.slice(0, maxCPL), normalized.slice(maxCPL, maxCPL * 2)]
      .filter(Boolean)
      .slice(0, 2);
  }

  const totalTextLength = normalized.length;

  // Score every candidate break position
  let bestScore = -Infinity;
  let bestIndex = Math.floor(words.length / 2) - 1;
  let hasValidBreak = false;

  for (let i = 0; i < words.length - 1; i++) {
    const line1 = words.slice(0, i + 1).join(' ');
    const line2 = words.slice(i + 1).join(' ');

    // Skip if line1 already exceeds CPL
    if (line1.length > maxCPL) continue;

    const score = scoreBreakPoint(words, i, totalTextLength);

    // Penalize heavily if line2 exceeds CPL (but don't skip — it may
    // be the only option)
    const adjustedScore = line2.length > maxCPL ? score - 200 : score;

    if (adjustedScore > bestScore) {
      bestScore = adjustedScore;
      bestIndex = i;
      hasValidBreak = true;
    }
  }

  if (!hasValidBreak) {
    return fallbackBreak(words, maxCPL);
  }

  const line1 = words.slice(0, bestIndex + 1).join(' ');
  const line2 = words.slice(bestIndex + 1).join(' ');

  // If line1 still exceeds CPL (shouldn't happen due to the skip above),
  // fall back to character-based split
  if (line1.length > maxCPL) {
    return fallbackBreak(words, maxCPL);
  }

  return [line1, line2].filter(Boolean).slice(0, 2);
}

/**
 * Convenience function: applies line breaking and returns the result
 * as a single string with lines joined by newline.
 *
 * @param text Subtitle text
 * @param maxCharsPerLine Maximum characters per line
 * @param language ISO 639-1 language code
 * @returns Text with optimal line breaks (\n separated)
 */
export function applyLineBreaking(
  text: string,
  maxCharsPerLine?: number,
  language?: string
): string {
  return findOptimalLineBreak(text, maxCharsPerLine, language).join('\n');
}
