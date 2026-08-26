import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import type { SiteMessage } from '../lib/types';
import { Badge, Button, Timestamp, type Tone } from './ui';

const ROLE_BADGE: Record<string, { label: string; tone: Tone }> = {
  admin: { label: 'Admin', tone: 'blue' },
  dev: { label: 'Dev', tone: 'slate' },
  partner: { label: 'Partner', tone: 'purple' },
};

/**
 * The discussion for one domain. This is where a question that is not a defect
 * goes - "is this domain AMP only?", "when does the contract end?" - so it stops
 * living in a mail thread while the issue list stays a list of work.
 */
export default function SiteChat({
  siteId,
  messages,
  onChange,
}: {
  siteId: number;
  messages: SiteMessage[];
  onChange: (messages: SiteMessage[]) => void;
}) {
  const { user } = useSession();
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<SiteMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const composer = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (replyTo) composer.current?.focus();
  }, [replyTo]);

  async function post(event: React.FormEvent) {
    event.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setError('');
    try {
      const { message } = await api.post<{ message: SiteMessage }>(`/sites/${siteId}/messages`, {
        body: body.trim(),
        reply_to_id: replyTo?.id ?? null,
      });
      onChange([...messages, message]);
      setBody('');
      setReplyTo(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post the message');
    } finally {
      setBusy(false);
    }
  }

  async function remove(message: SiteMessage) {
    try {
      await api.del(`/sites/${siteId}/messages/${message.id}`);
      onChange(messages.map((m) => (m.id === message.id ? { ...m, deleted_at: new Date().toISOString(), body: '' } : m)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the message');
    }
  }

  return (
    <section className="card flex flex-col">
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">Discussion</h2>
        <span className="text-xs text-ink-faint">
          {messages.length === 0 ? 'Nothing yet' : `${messages.length} message${messages.length === 1 ? '' : 's'}`}
        </span>
      </header>

      <div className="max-h-[28rem] space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <p className="py-4 text-center text-sm text-ink-faint">
            Ask a question about this domain here - everyone with access can answer.
          </p>
        )}

        {messages.map((message) => {
          const mine = message.author_id === user?.id;
          const badge = message.author_role ? ROLE_BADGE[message.author_role] : null;

          return (
            <article key={message.id} className="group rounded-lg border border-line bg-raised/40 px-3 py-2">
              {message.reply_to_id && (
                <div className="mb-1.5 border-l-2 border-line-strong pl-2 text-xs text-ink-faint">
                  <span className="font-medium">{message.reply_to_author ?? 'Deleted user'}</span>{' '}
                  <span className="line-clamp-2">
                    {message.reply_to_deleted_at ? <em>message deleted</em> : message.reply_to_body}
                  </span>
                </div>
              )}

              <header className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="font-medium">{message.author_name ?? 'Imported note'}</span>
                {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
                <Timestamp iso={message.created_at} className="text-ink-faint" />

                {!message.deleted_at && (
                  <span className="ml-auto flex gap-2 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                    <button onClick={() => setReplyTo(message)} className="text-ink-faint hover:text-brand">
                      Reply
                    </button>
                    {(mine || user?.role === 'admin') && (
                      <button onClick={() => remove(message)} className="text-ink-faint hover:text-tone-red">
                        Delete
                      </button>
                    )}
                  </span>
                )}
              </header>

              {message.deleted_at ? (
                <p className="mt-1 text-sm text-ink-faint italic">This message was deleted.</p>
              ) : (
                <p className="mt-1 text-sm whitespace-pre-wrap">{message.body}</p>
              )}
            </article>
          );
        })}
      </div>

      <form onSubmit={post} className="space-y-2 border-t border-line px-4 py-3">
        {replyTo && (
          <div className="flex items-start gap-2 rounded-lg bg-brand-soft px-2.5 py-1.5 text-xs text-brand-ink">
            <span className="min-w-0 flex-1">
              Replying to <span className="font-medium">{replyTo.author_name ?? 'a message'}</span>:{' '}
              <span className="line-clamp-1">{replyTo.body}</span>
            </span>
            <button type="button" onClick={() => setReplyTo(null)} aria-label="Cancel reply">
              ✕
            </button>
          </div>
        )}

        <textarea
          ref={composer}
          className="field min-h-20"
          placeholder="Ask something, or answer a question..."
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter starts a new line - the usual chat habit.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              post(event as unknown as React.FormEvent);
            }
          }}
        />

        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-faint">Enter sends · Shift+Enter for a new line</span>
          <Button type="submit" size="sm" variant="primary" className="ml-auto" disabled={busy || !body.trim()}>
            {busy ? 'Sending...' : 'Send'}
          </Button>
        </div>

        {error && <p className="text-xs text-tone-red">{error}</p>}
      </form>
    </section>
  );
}
