'use strict';

const INVISIBLE_OR_DIRECTIONAL_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

function escapeInvisibleCharacters(value) {
  return [...String(value)].map((character) => {
    if (!INVISIBLE_OR_DIRECTIONAL_CHARACTER.test(character)) {
      return character;
    }

    const codePoint = character.codePointAt(0);
    return `<U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}>`;
  }).join('');
}

// Filenames and rule names may contain Markdown delimiters or invisible control characters. A code
// span with a dynamically sized fence keeps those values inert and visually unambiguous.
function formatUntrustedInlineCode(value) {
  const escaped = escapeInvisibleCharacters(value);
  const longestBacktickRun = Math.max(
    0,
    ...(escaped.match(/`+/g) || []).map((run) => run.length),
  );
  const fence = '`'.repeat(longestBacktickRun + 1);
  return `${fence} ${escaped} ${fence}`;
}

// GitHub turns model-authored @names and @org/team strings into notifications. Insert a zero-width
// separator after every mention-shaped @ token. This intentionally includes email-shaped text:
// notification prevention is more important than preserving automatic mail links.
function neutralizeGitHubMentions(value) {
  return String(value).replace(
    /@(?=[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9][A-Za-z0-9-]*)?)/gu,
    '@\u200b',
  );
}

module.exports = {
  escapeInvisibleCharacters,
  formatUntrustedInlineCode,
  neutralizeGitHubMentions,
};
