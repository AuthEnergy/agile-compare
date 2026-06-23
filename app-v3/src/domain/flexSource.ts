import type { FlexColumnSource } from '../types/result';

export function flexColumnLabel(source: FlexColumnSource): string {
  switch (source.kind) {
    case 'current-tariff-rates':
      return `${source.label} (calc.)`;
    case 'flexible-proxy':
      return 'Flexible proxy (calc.)';
    default:
      return source.label;
  }
}

export function calculatedBaselineLabel(source: FlexColumnSource): string {
  switch (source.kind) {
    case 'flexible-current':
      return `${source.label} (calc.)`;
    case 'current-tariff-rates':
      return `${source.label} (calc.)`;
    case 'flexible-proxy':
      return 'Flexible proxy (calc.)';
    case 'user-override':
      return `${source.label} (calc.)`;
    case 'flexible-alternative':
      return 'Flexible (calc.)';
  }
}

export function shareFlexLabel(source: FlexColumnSource): string {
  switch (source.kind) {
    case 'flexible-proxy':
      return 'Flexible proxy';
    case 'current-tariff-rates':
      return source.label;
    default:
      return source.label;
  }
}
