import { object, text, type ServerRecord } from './types';

export default function ActionReviewReason({ record }: { record: ServerRecord }) {
  const review = object(record.data.review);
  const reason = typeof record.data.review === 'string' ? record.data.review : typeof review.reason === 'string' ? review.reason : '';
  const category = text(record, 'reviewCategory') || (typeof review.category === 'string' ? review.category : '') || text(record, 'classification');
  if (!reason && !category) return null;
  return <p className="small action-review-reason">Review{category ? ` · ${category.replaceAll('_', ' ')}` : ''}{reason ? `: ${reason}` : ''}</p>;
}
