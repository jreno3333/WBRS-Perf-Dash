/**
 * Email Alert Classifier
 *
 * Classifies incoming email alerts by sentiment (positive/negative/neutral),
 * category (food_quality, service, cleanliness, etc.), and severity (1-3).
 *
 * Also attempts to extract the restaurant name/unit from the email subject/body
 * and match it to a known restaurant in the database.
 */

import { db } from "./db";
import { restaurants } from "@shared/schema";

// ─── Keyword dictionaries ────────────────────────────────────────────────────

const NEGATIVE_KEYWORDS = [
  "complaint", "complain", "upset", "angry", "disappointed", "disgusted",
  "horrible", "terrible", "worst", "awful", "unacceptable", "rude",
  "cold food", "wrong order", "missing item", "missing items", "long wait",
  "dirty", "filthy", "hair in", "bug in", "foreign object",
  "food poisoning", "sick", "ill", "health department", "health dept",
  "refund", "money back", "overcharged", "double charged",
  "never coming back", "never again", "never return",
  "slow service", "took forever", "waited", "waiting",
  "raw", "undercooked", "burnt", "stale", "expired",
  "manager", "corporate", "escalat",
];

const POSITIVE_KEYWORDS = [
  "compliment", "praise", "thank", "thanks", "excellent", "amazing",
  "great job", "wonderful", "outstanding", "above and beyond",
  "best experience", "love", "loved", "awesome", "fantastic",
  "friendly", "fast service", "quick service", "delicious",
  "clean", "spotless", "well done", "impressed", "kudos",
  "recommend", "five star", "5 star", "perfect",
];

const HIGH_SEVERITY_KEYWORDS = [
  "health department", "health dept", "food poisoning", "allergic reaction",
  "hospital", "emergency", "lawyer", "legal", "lawsuit", "attorney",
  "media", "news", "social media", "viral", "bbb", "better business",
  "foreign object", "glass", "metal", "plastic in food",
];

const MEDIUM_SEVERITY_KEYWORDS = [
  "refund", "money back", "overcharged", "double charged",
  "manager", "corporate", "escalat", "multiple times", "third time",
  "never coming back", "never again", "lost customer",
  "wrong order", "completely wrong", "missing item",
];

// Category keyword mappings
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  food_quality: [
    "food", "taste", "cold", "raw", "undercooked", "burnt", "stale",
    "expired", "quality", "portion", "flavor", "temperature", "soggy",
    "dry", "greasy", "fresh", "delicious",
  ],
  service: [
    "service", "rude", "attitude", "ignored", "slow", "waited", "waiting",
    "friendly", "helpful", "polite", "staff", "employee", "cashier",
    "team member", "crew",
  ],
  order_accuracy: [
    "wrong order", "missing item", "missing items", "incorrect",
    "not what i ordered", "forgot", "forgotten", "left out", "extra",
    "substitut",
  ],
  cleanliness: [
    "dirty", "filthy", "clean", "mess", "trash", "bathroom", "restroom",
    "table", "floor", "sticky", "hair in", "bug", "roach", "pest",
    "spotless",
  ],
  wait_time: [
    "wait", "waited", "waiting", "slow", "forever", "long time",
    "drive thru", "drive-thru", "line", "queue", "took forever",
    "fast", "quick",
  ],
  staff: [
    "manager", "employee", "worker", "team member", "crew member",
    "cashier", "shift lead", "supervisor", "operator",
  ],
};

// ─── Classification functions ────────────────────────────────────────────────

export interface ClassificationResult {
  sentiment: "positive" | "negative" | "neutral";
  category: string;
  severity: number; // 1-3
  restaurantName: string | null;
  restaurantId: string | null;
}

function countKeywordMatches(text: string, keywords: string[]): number {
  let count = 0;
  for (const kw of keywords) {
    if (text.includes(kw)) count++;
  }
  return count;
}

function classifySentiment(text: string): "positive" | "negative" | "neutral" {
  const negativeScore = countKeywordMatches(text, NEGATIVE_KEYWORDS);
  const positiveScore = countKeywordMatches(text, POSITIVE_KEYWORDS);

  if (negativeScore > positiveScore && negativeScore > 0) return "negative";
  if (positiveScore > negativeScore && positiveScore > 0) return "positive";
  if (negativeScore > 0 && positiveScore > 0) return "negative"; // tie → negative (err on caution)
  return "neutral";
}

function classifyCategory(text: string): string {
  let bestCategory = "general";
  let bestScore = 0;

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    const score = countKeywordMatches(text, keywords);
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  return bestCategory;
}

function classifySeverity(text: string): number {
  if (countKeywordMatches(text, HIGH_SEVERITY_KEYWORDS) > 0) return 3;
  if (countKeywordMatches(text, MEDIUM_SEVERITY_KEYWORDS) > 0) return 2;
  return 1;
}

/**
 * Try to extract a restaurant name or unit number from the email subject/body.
 * Common patterns: "Store #1237", "Unit 1237", "Whataburger 1237", location names, etc.
 */
function extractRestaurantRef(text: string): string | null {
  // Match patterns like: store #1237, unit 1237, store 1237, #1237, location 1237
  const patterns = [
    /(?:store|unit|location|restaurant)\s*#?\s*(\d{3,5})/i,
    /#(\d{3,5})/,
    /\b(\d{4})\s*(?:store|unit|location)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }

  return null;
}

/**
 * Match extracted restaurant reference to a restaurant in the database.
 */
async function matchRestaurant(
  ref: string | null,
  fullText: string
): Promise<{ id: string; name: string } | null> {
  if (!ref && !fullText) return null;

  const allRestaurants = await db.select().from(restaurants);

  // Try matching by unit number first
  if (ref) {
    const byUnit = allRestaurants.find(
      (r) => r.unitNumber === ref || r.name.includes(ref)
    );
    if (byUnit) return { id: byUnit.id, name: byUnit.name };
  }

  // Try fuzzy match on restaurant name in the text
  for (const r of allRestaurants) {
    const nameLower = r.name.toLowerCase();
    if (fullText.includes(nameLower)) {
      return { id: r.id, name: r.name };
    }
    // Also check unit number in text
    if (r.unitNumber && fullText.includes(r.unitNumber)) {
      return { id: r.id, name: r.name };
    }
  }

  return null;
}

/**
 * Classify an email alert and match it to a restaurant.
 */
export async function classifyEmailAlert(
  subject: string,
  bodyText: string | null
): Promise<ClassificationResult> {
  const text = `${subject} ${bodyText || ""}`.toLowerCase();

  const sentiment = classifySentiment(text);
  const category = classifyCategory(text);
  const severity = classifySeverity(text);

  const ref = extractRestaurantRef(text);
  const restaurant = await matchRestaurant(ref, text);

  return {
    sentiment,
    category,
    severity,
    restaurantName: restaurant?.name || null,
    restaurantId: restaurant?.id || null,
  };
}
