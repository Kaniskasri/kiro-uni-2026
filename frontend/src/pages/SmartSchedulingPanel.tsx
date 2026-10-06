import { useState } from 'react';
import { apiClient, extractApiError } from '../lib/apiClient';
import { useOrgStore } from '../stores/orgStore';
import { AIScheduleSuggestion } from '../types';

export function SmartSchedulingPanel() {
  const { currentOrg } = useOrgStore();
  const orgId = currentOrg?.orgId ?? '';
  const [suggestions, setSuggestions] = useState<AIScheduleSuggestion[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [insufficientData, setInsufficientData] = useState(false);

  const suggest = async () => {
    setError(null); setSuggestions(null); setInsufficientData(false);
    setLoading(true);
    try {
      const res = await apiClient.post<{ suggestions: AIScheduleSuggestion[]; insufficientData?: boolean }>(
        `/orgs/${orgId}/ai/suggest-schedule`
      );
      if (res.data.insufficientData) {
        setInsufficientData(true);
      } else {
        setSuggestions(res.data.suggestions);
      }
    } catch (err) {
      setError(extractApiError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section aria-labelledby="sched-panel-title" className="border border-purple-100 rounded-lg p-4 bg-purple-50">
      <h3 id="sched-panel-title" className="text-sm font-semibold text-purple-800 mb-3">📅 Smart scheduling suggestions</h3>

      <button onClick={suggest} disabled={loading}
        className="rounded bg-purple-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
        aria-label="Get AI scheduling suggestions">
        {loading ? 'Analyzing…' : 'Suggest schedule'}
      </button>

      {error && (
        <div role="alert" className="mt-3 rounded bg-yellow-50 border border-yellow-300 px-3 py-2 text-xs text-yellow-800">
          AI unavailable: {error}
        </div>
      )}

      {insufficientData && (
        <div role="status" className="mt-3 text-xs text-purple-700">
          <p className="font-medium mb-2">Not enough data (need ≥ 5 completed events).</p>
          <p className="text-gray-600 mb-1">General recommendations:</p>
          <ul className="list-disc ml-4 space-y-0.5 text-gray-600">
            <li>Tuesday evenings (6–8pm) — high community engagement</li>
            <li>Saturday mornings (10am–12pm) — good for workshops</li>
            <li>Thursday lunchtimes (12–1:30pm) — mid-week professional events</li>
          </ul>
        </div>
      )}

      {suggestions && suggestions.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-gray-500">Based on your past {suggestions.length} suggested slots:</p>
          {suggestions.map((s, i) => (
            <div key={i} className="bg-white rounded border border-purple-200 p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium text-gray-900">{s.dayOfWeek} · {s.timeSlot}</span>
                <span className="text-xs font-bold text-purple-700">{s.predictedAttendance}% predicted</span>
              </div>
              <ul className="text-xs text-gray-500 list-disc ml-4">
                {s.reasoningFactors.map((f, j) => <li key={j}>{f}</li>)}
              </ul>
            </div>
          ))}
          <p className="text-xs text-gray-400 italic">
            * AI predictions are indicative only. Actual attendance may vary.
          </p>
        </div>
      )}
    </section>
  );
}
