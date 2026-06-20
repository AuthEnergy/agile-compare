const KEY = 'otc-analytics-consent';

// Returns true (default on a genuinely first visit) if the preference has never
// been saved. Returns the stored value once the user has interacted with the checkbox.
export function loadAnalyticsConsent(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    return v === null ? true : v !== 'false';
  } catch {
    return false; // storage unavailable: do not send analytics
  }
}

export function saveAnalyticsConsent(consent: boolean): void {
  try {
    localStorage.setItem(KEY, String(consent));
  } catch {
    /* storage may be unavailable */
  }
}
