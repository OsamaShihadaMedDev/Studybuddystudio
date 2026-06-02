export type MediaType =
  | 'ecg'
  | 'histology_slide'
  | 'chest_xray'
  | 'anatomical_diagram'
  | 'action_potential_diagram'
  | 'pressure_volume_diagram';

export type DisplayContext = 'stem' | 'explanation' | 'both';

export type License = 'CC0' | 'CC-BY' | 'public_domain' | 'ODC-BY' | 'proprietary';

const TYPE_TOKEN_MAP: Record<string, MediaType> = {
  ecg:        'ecg',
  histology:  'histology_slide',
  xray:       'chest_xray',
  diagram:    'anatomical_diagram',
  action_pot: 'action_potential_diagram',
  pv_loop:    'pressure_volume_diagram',
};

export interface ParsedFilename {
  displayContext: DisplayContext;
  mediaType: MediaType;
}

/**
 * Parses a media filename into a display context and media type.
 *
 * Rules (case-insensitive, applied to the filename without its extension):
 * - `displayContext` is derived from substring presence: contains "stem" → "stem",
 *   contains "explanation" → "explanation", contains both → "both". If neither is
 *   present, an error is thrown.
 * - `mediaType` is resolved by first splitting on dots and looking up each part in
 *   `TYPE_TOKEN_MAP`. If no dot-segment matches, it falls back to scanning the
 *   filename for any `TYPE_TOKEN_MAP` key as a substring. If still no match, an
 *   error is thrown.
 *
 * Examples: `stem.histology.png`, `stem_diagram.png`, `explanation_diagram.png`,
 * `both.ecg.png` are all accepted.
 */
export function parseMediaFilename(filename: string): ParsedFilename {
  const withoutExt = filename.replace(/\.[^.]+$/, '');
  const lower = withoutExt.toLowerCase();

  const hasStem = lower.includes('stem');
  const hasExplanation = lower.includes('explanation');

  let displayContext: DisplayContext;
  if (hasStem && hasExplanation) {
    displayContext = 'both';
  } else if (hasStem) {
    displayContext = 'stem';
  } else if (hasExplanation) {
    displayContext = 'explanation';
  } else {
    throw new Error(
      `Invalid media filename "${filename}". Filename must contain "stem", "explanation", or both.`
    );
  }

  let mediaType: MediaType | undefined;
  for (const part of lower.split('.')) {
    if (TYPE_TOKEN_MAP[part]) {
      mediaType = TYPE_TOKEN_MAP[part];
      break;
    }
  }

  if (!mediaType) {
    for (const token of Object.keys(TYPE_TOKEN_MAP)) {
      if (lower.includes(token)) {
        mediaType = TYPE_TOKEN_MAP[token];
        break;
      }
    }
  }

  if (!mediaType) {
    const validTokens = Object.keys(TYPE_TOKEN_MAP).join(', ');
    throw new Error(
      `Unknown media type in "${filename}". Filename must contain one of: ${validTokens}.`
    );
  }

  return {
    displayContext,
    mediaType,
  };
}

export function validTypeTokens(): string[] {
  return Object.keys(TYPE_TOKEN_MAP);
}
