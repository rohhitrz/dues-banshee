/**
 * Phrases the Tone_Check blocks. Lowercase, matched as whole words after `normalise`.
 * English entries first, then Hinglish (Roman script). Words a respectful draft uses for
 * facts or courtesy ("please", "kripya", "interest", "MSME", "ODR", ...) never belong here.
 */
export const THREAT_LIST: readonly string[] = [
  // English
  "legal action will be taken",
  "we will take legal action",
  "strict action",
  "final warning",
  "last warning",
  "you will regret",
  "face the consequences",
  "blacklist",
  "police",
  "we will sue",
  // Hinglish
  "warna baat aage",
  "warna dekh",
  "dekh lenge",
  "anjaam",
  "bhugatna padega",
  "case kar denge",
  "court mein ghaseet",
  "sabak sikha",
  "chhodenge nahi",
  "aakhri chetavani",
];

export const BEGGING_LIST: readonly string[] = [
  // English
  "i beg",
  "begging you",
  "please please",
  "have mercy",
  "we are desperate",
  "we are helpless",
  // Hinglish
  "haath jodkar",
  "minnat",
  "daya karo",
  "reham",
  "bahut majboor",
  "aapke pair",
];
