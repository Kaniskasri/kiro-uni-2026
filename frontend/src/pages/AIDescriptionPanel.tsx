import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { apiClient, extractApiError } from '../lib/apiClient';
import { useOrgStore } from '../stores/orgStore';

const schema = z.object({
  title: z.string().min(1),
  keywords: z.string(),
  targetAudience: z.string().min(1, 'Describe your target audience'),
});
type Form = z.infer<typeof schema>;

interface Props {
  eventTitle: string;
  onAccept: (text: string) => void;
}

export function AIDescriptionPanel({ eventTitle, onAccept }: Props) {
  const { currentOrg } = useOrgStore();
  const orgId = currentOrg?.orgId ?? '';
  const [draft, setDraft] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { isSubmitting } } =
    useForm<Form>({ resolver: zodResolver(schema), defaultValues: { title: eventTitle } });

  const generate = async (data: Form) => {
    setAiError(null); setDraft(null);
    try {
      const keywords = data.keywords.split(',').map((k) => k.trim()).filter(Boolean);
      const res = await apiClient.post<{ description: string }>(
        `/orgs/${orgId}/ai/describe-event`,
        { title: data.title, keywords, targetAudience: data.targetAudience }
      );
      setDraft(res.data.description);
    } catch (err) {
      setAiError(extractApiError(err));
    }
  };

  return (
    <section aria-labelledby="ai-panel-title" className="border border-blue-100 rounded-lg p-4 bg-blue-50">
      <h3 id="ai-panel-title" className="text-sm font-semibold text-blue-800 mb-3">✨ AI description generator</h3>

      <form onSubmit={handleSubmit(generate)} noValidate aria-label="AI description generator">
        <input type="hidden" {...register('title')} />
        <div className="mb-2">
          <label htmlFor="ai-keywords" className="block text-xs font-medium text-gray-700 mb-1">
            Keywords (comma-separated)
          </label>
          <input id="ai-keywords" type="text" {...register('keywords')} placeholder="networking, startup, tech"
            className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div className="mb-3">
          <label htmlFor="ai-audience" className="block text-xs font-medium text-gray-700 mb-1">
            Target audience
          </label>
          <input id="ai-audience" type="text" {...register('targetAudience')} placeholder="software developers, founders"
            className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <button type="submit" disabled={isSubmitting}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {isSubmitting ? 'Generating…' : 'Generate with AI'}
        </button>
      </form>

      {aiError && (
        <div role="alert" className="mt-3 rounded bg-yellow-50 border border-yellow-300 px-3 py-2 text-xs text-yellow-800">
          AI unavailable: {aiError}
        </div>
      )}

      {draft && (
        <div className="mt-3">
          <label htmlFor="ai-draft" className="block text-xs font-medium text-gray-700 mb-1">
            Generated draft (editable)
          </label>
          <textarea id="ai-draft" rows={6} value={draft} onChange={(e) => setDraft(e.target.value)}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <div className="flex gap-2 mt-2">
            <button type="button" onClick={() => onAccept(draft)}
              className="rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700">
              Use this description
            </button>
            <button type="button" onClick={() => setDraft(null)}
              className="rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-600">
              Discard
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
