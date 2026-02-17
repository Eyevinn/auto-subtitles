/**
 * Language-aware configuration for subtitle formatting.
 *
 * CPS values are based on cross-linguistic reading speed research:
 * - Szarkowska et al. (2016) "Subtitle reading speeds in different languages"
 * - Marin Garcia (2013) "Subtitle reading speed: A new tool for its estimation"
 * - Netflix Timed Text Style Guide (language-specific CPL/CPS limits)
 * - BBC Subtitle Guidelines v1.2.3 (June 2024)
 * - EBU six-second rule (12 CPS baseline)
 *
 * Key insight: CPS measures characters, not information. German has longer
 * words than English, so the same WPM translates to a higher CPS. CJK
 * characters carry far more information per character, so CPS is much lower
 * but information throughput is comparable.
 */

export interface LanguageConfig {
  /** Target characters per second for comfortable reading */
  cps: number;
  /** Maximum acceptable CPS before quality degrades significantly */
  maxCps: number;
  /** Maximum characters per line */
  cpl: number;
  /** Minimum subtitle duration in seconds */
  minDuration: number;
  /** Maximum subtitle duration in seconds */
  maxDuration: number;
  /** Maximum number of lines per subtitle cue */
  maxLines: number;
  /** Minimum gap between consecutive subtitles in seconds (~2 frames at 24fps) */
  minGap: number;
  /** Script type for formatting decisions */
  scriptType: 'latin' | 'cjk' | 'rtl' | 'indic' | 'thai';
}

const DEFAULT_CONFIG: LanguageConfig = {
  cps: 12,
  maxCps: 17,
  cpl: 42,
  minDuration: 1.0,
  maxDuration: 7.0,
  maxLines: 2,
  minGap: 0.083,
  scriptType: 'latin'
};

/**
 * Language-specific configurations keyed by ISO 639-1 codes.
 *
 * CPS rationale (selected examples):
 * - en (15 CPS): English avg reading 228 WPM, moderate word length
 * - de (20 CPS): German avg reading 179 WPM, but long words = more chars/WPM
 * - zh (6 CPS): Chinese avg reading 158 WPM, but each char ~2-3 Latin chars of info
 * - ar (11 CPS): Arabic avg reading 138 WPM, partial vowels, RTL
 */
const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
  // --- Germanic languages ---
  en: {
    cps: 15,
    maxCps: 20,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'latin'
  },
  de: {
    cps: 20,
    maxCps: 25,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'latin'
  },
  nl: {
    cps: 18,
    maxCps: 23,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'latin'
  },
  sv: {
    cps: 17,
    maxCps: 22,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'latin'
  },
  da: {
    cps: 17,
    maxCps: 22,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'latin'
  },
  no: {
    cps: 17,
    maxCps: 22,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'latin'
  },

  // --- Romance languages ---
  fr: {
    cps: 17,
    maxCps: 22,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'latin'
  },
  es: {
    cps: 17,
    maxCps: 22,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'latin'
  },
  pt: {
    cps: 17,
    maxCps: 22,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'latin'
  },
  it: {
    cps: 16,
    maxCps: 21,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'latin'
  },
  ro: {
    cps: 16,
    maxCps: 21,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'latin'
  },

  // --- Slavic languages ---
  ru: {
    cps: 16,
    maxCps: 21,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'latin'
  },
  pl: {
    cps: 15,
    maxCps: 20,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'latin'
  },
  cs: {
    cps: 16,
    maxCps: 21,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'latin'
  },
  uk: {
    cps: 16,
    maxCps: 21,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'latin'
  },
  hr: {
    cps: 16,
    maxCps: 21,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'latin'
  },
  bg: {
    cps: 16,
    maxCps: 21,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'latin'
  },

  // --- Other European ---
  fi: {
    cps: 14,
    maxCps: 19,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'latin'
  },
  el: {
    cps: 15,
    maxCps: 20,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'latin'
  },
  hu: {
    cps: 15,
    maxCps: 20,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'latin'
  },
  tr: {
    cps: 15,
    maxCps: 20,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'latin'
  },

  // --- CJK languages ---
  ja: {
    cps: 5,
    maxCps: 8,
    cpl: 16,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'cjk'
  },
  zh: {
    cps: 6,
    maxCps: 9,
    cpl: 16,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'cjk'
  },
  ko: {
    cps: 6,
    maxCps: 9,
    cpl: 16,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'cjk'
  },

  // --- RTL languages ---
  ar: {
    cps: 11,
    maxCps: 15,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'rtl'
  },
  he: {
    cps: 12,
    maxCps: 16,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'rtl'
  },
  fa: {
    cps: 11,
    maxCps: 15,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'rtl'
  },

  // --- Indic languages ---
  hi: {
    cps: 12,
    maxCps: 17,
    cpl: 38,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'indic'
  },
  ta: {
    cps: 11,
    maxCps: 16,
    cpl: 35,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'indic'
  },
  bn: {
    cps: 11,
    maxCps: 16,
    cpl: 38,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'indic'
  },
  te: {
    cps: 11,
    maxCps: 16,
    cpl: 38,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'indic'
  },

  // --- Southeast Asian ---
  th: {
    cps: 10,
    maxCps: 14,
    cpl: 35,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'thai'
  },
  vi: {
    cps: 14,
    maxCps: 19,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'latin'
  },
  id: {
    cps: 16,
    maxCps: 21,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'latin'
  },
  ms: {
    cps: 16,
    maxCps: 21,
    cpl: 42,
    minDuration: 1.0,
    maxDuration: 7.0,
    maxLines: 2,
    minGap: 0.083,
    scriptType: 'latin'
  }
};

/**
 * Returns the subtitle configuration for a given language.
 * Falls back to sensible defaults if the language is unknown.
 *
 * Accepts full locale codes (e.g. 'en-US') and extracts the
 * two-letter ISO 639-1 prefix.
 */
export function getLanguageConfig(language?: string): LanguageConfig {
  if (!language) return { ...DEFAULT_CONFIG };
  const normalized = language.toLowerCase().split('-')[0].slice(0, 2);
  return LANGUAGE_CONFIGS[normalized]
    ? { ...LANGUAGE_CONFIGS[normalized] }
    : { ...DEFAULT_CONFIG };
}

/**
 * Returns all supported language codes.
 */
export function getSupportedLanguages(): string[] {
  return Object.keys(LANGUAGE_CONFIGS);
}

/**
 * Checks if a language code has a specific configuration entry.
 * Languages without an entry still work using defaults.
 */
export function hasLanguageConfig(language: string): boolean {
  const normalized = language.toLowerCase().split('-')[0].slice(0, 2);
  return normalized in LANGUAGE_CONFIGS;
}
