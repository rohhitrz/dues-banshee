const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
] as const;

const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"] as const;

/** 1..99 as words: "nineteen", "forty-one", "ninety". */
function belowHundred(n: number): string {
  if (n < 20) return ONES[n] as string;
  const tens = TENS[Math.floor(n / 10)] as string;
  const ones = n % 10;
  return ones === 0 ? tens : `${tens}-${ONES[ones] as string}`;
}

/** 1..999 as words, with no "and": "five hundred nineteen". */
function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds > 0) parts.push(`${ONES[hundreds] as string} hundred`);
  if (rest > 0) parts.push(belowHundred(rest));
  return parts.join(" ");
}

/**
 * A whole number in the Indian system: crore (10^7), lakh (10^5), thousand, hundred. Crore is the
 * top unit, so 10^9 is "one hundred crore" and 10^12 is "one lakh crore".
 */
function indianWords(n: number): string {
  if (n === 0) return "zero";
  const parts: string[] = [];
  let rest = n;

  const crore = Math.floor(rest / 10_000_000);
  if (crore > 0) {
    parts.push(`${indianWords(crore)} crore`);
    rest %= 10_000_000;
  }
  const lakh = Math.floor(rest / 100_000);
  if (lakh > 0) {
    parts.push(`${belowHundred(lakh)} lakh`);
    rest %= 100_000;
  }
  const thousand = Math.floor(rest / 1000);
  if (thousand > 0) {
    parts.push(`${belowHundred(thousand)} thousand`);
    rest %= 1000;
  }
  if (rest > 0) parts.push(belowThousand(rest));
  return parts.join(" ");
}

/**
 * An amount in paise as spoken English in the Indian system, for a voice agent that must say rupees
 * only: 41851941 -> "four lakh eighteen thousand five hundred nineteen rupees and forty-one paise".
 * Zero rupees leave out the rupee part ("one paise"), zero paise leave out the paise part, and
 * 0 is "zero rupees". Throws for a negative or non-integer amount.
 */
export function paiseToWords(paise: number): string {
  if (!Number.isSafeInteger(paise) || paise < 0) {
    throw new RangeError("paiseToWords requires a non-negative integer number of paise");
  }
  const rupees = Math.floor(paise / 100);
  const rest = paise % 100;

  const parts: string[] = [];
  if (rupees > 0 || rest === 0) parts.push(`${indianWords(rupees)} ${rupees === 1 ? "rupee" : "rupees"}`);
  if (rest > 0) parts.push(`${belowHundred(rest)} paise`);
  return parts.join(" and ");
}
