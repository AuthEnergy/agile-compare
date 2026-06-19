import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearApiKey,
  hasSavedApiKey,
  loadSavedApiKey,
  saveApiKey,
} from '../../src/storage/credentials';

describe('credentials storage', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips an opt-in key and clears it', () => {
    expect(loadSavedApiKey()).toBeNull();
    expect(hasSavedApiKey()).toBe(false);

    saveApiKey('sk_test_FAKE');
    expect(loadSavedApiKey()).toBe('sk_test_FAKE');
    expect(hasSavedApiKey()).toBe(true);

    clearApiKey();
    expect(loadSavedApiKey()).toBeNull();
    expect(hasSavedApiKey()).toBe(false);
  });

  it('returns null for malformed stored JSON', () => {
    localStorage.setItem('octopus-tariff-check-credentials', '{not json');
    expect(loadSavedApiKey()).toBeNull();
  });

  it('returns null when the stored object lacks a string apiKey', () => {
    localStorage.setItem('octopus-tariff-check-credentials', JSON.stringify({ apiKey: 42 }));
    expect(loadSavedApiKey()).toBeNull();
  });
});
