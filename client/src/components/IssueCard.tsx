import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import type { Attachment, Comment, Issue, IssueStatus, User } from '../lib/types';
import { ISSUE_CATEGORY, ISSUE_STATUS, ISSUE_TYPE, SEVERITY } from '@shared/domain.js';
import { Badge, Button, InlineSelect, Timestamp, relativeTime, type Tone } from './ui';

/** Mirrors the server-side transition table so the UI never offers a rejected move. */
const ALLOWED_TRANSITIONS: Record<string, IssueStatus[]> = {
  admin: Object.keys(ISSUE_STATUS) as IssueStatus[],
  dev: ['open', 'in_progress', 'ready_for_qa', 'wont_fix'],
  partner: ['open', 'verified', 'wont_fix'],
};

/** The single obvious next step per role, surfaced as a button next to the dropdown. */
function primaryAction(status: IssueStatus, role: string): { next: IssueStatus; label: string } | null {
  if (role === 'partner') {
    if (status === 'ready_for_qa') return { next: 'verified', label: 'Verified — close it' };
    if (status === 'verified') return { next: 'open', label: 'Reopen' };
    return null;
  }
  if (status === 'open') return { next: 'in_progress', label: 'Start working' };
  if (status === 'in_progress') return { next: 'ready_for_qa', label: 'Fixed — ask for re-check' };
  if (status === 'ready_for_qa' && role === 'admin') return { next: 'verified', label: 'Verify' };
  return null;
}

export default function IssueCard({
  issue: initial,
  users,
  showDomain = false,
  defaultOpen = false,
  onChanged,
}: {
  issue: Issue;
  users: User[];
  showDomain?: boolean;
  defaultOpen?: boolean;
  onChanged?: (issue: Issue) => void;
}) {
  const { user } = useSession();
  const [issue, setIssue] = useState(initial);
  const [open, setOpen] = useState(defaultOpen);
  const [detail, setDetail] = useState<{ comments: Comment[]; attachments: Attachment[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => setIssue(initial), [initial]);

  useEffect(() => {
    if (!open || detail) return;
    setLoading(true);
    api
      .get<{ comments: Comment[]; attachments: Attachment[] }>(`/issues/${issue.id}`)
      .then((r) => setDetail({ comments: r.comments, attachments: r.attachments }))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [open, detail, issue.id]);

  async function update(patch: Partial<Issue>) {
    setError('');
    try {
      const { issue: saved } = await api.patch<{ issue: Issue }>(`/issues/${issue.id}`, patch);
      const merged = { ...issue, ...saved };
      setIssue(merged);
      onChanged?.(merged);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the change');
    }
  }

  const status = ISSUE_STATUS[issue.status] as { label: string; tone: Tone };
  const severity = SEVERITY[issue.severity] as { label: string; tone: Tone };
  const type = ISSUE_TYPE[issue.type] as { label: string; tone: Tone };
  const action = user ? primaryAction(issue.status, user.role) : null;
  const overdue = Boolean(issue.due_date) && !ISSUE_STATUS[issue.status].terminal && issue.due_date! < new Date().toISOString().slice(0, 10);
  const statusOptions = (ALLOWED_TRANSITIONS[user?.role ?? 'partner'] ?? [])
    .map((value) => ({ value, label: ISSUE_STATUS[value].label }));
  const issueAttachments = detail?.attachments.filter((a) => a.comment_id == null) ?? [];

  return (
    <div className={`card overflow-hidden ${issue.status === 'open' ? 'border-l-2 border-l-tone-red' : ''}`}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3">
        <button onClick={() => setOpen(!open)} className="mt-0.5 shrink-0 text-ink-faint hover:text-ink" aria-label={open ? 'Collapse' : 'Expand'}>
          {open ? '▾' : '▸'}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={status.tone}>{status.label}</Badge>
            <Badge tone={type.tone}>{type.label}</Badge>
            <Badge tone={severity.tone}>{severity.label}</Badge>
            {showDomain && issue.domain && (
              <Link to={`/sites/${issue.site_id}`} className="text-xs font-medium text-ink-soft hover:text-brand hover:underline">
                {issue.domain}
              </Link>
            )}
            {issue.batch_id && (
              <Link to={`/issues?batch=${issue.batch_id}`} className="text-xs text-ink-faint hover:text-brand" title="Same finding across several domains">
                ⧉ batch
              </Link>
            )}
          </div>

          <button onClick={() => setOpen(!open)} className="mt-1 block text-left text-sm font-medium hover:text-brand">
            {issue.title}
          </button>

          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-faint">
            <span>#{issue.id}</span>
            <span>{ISSUE_CATEGORY[issue.category as keyof typeof ISSUE_CATEGORY] ?? issue.category}</span>
            <span>
              Raised by <span className="text-ink-soft">{issue.reporter_name ?? 'unknown'}</span> · <Timestamp iso={issue.created_at} />
            </span>
            {issue.assignee_name && <span>Assigned to <span className="text-ink-soft">{issue.assignee_name}</span></span>}
            {issue.due_date && (
              <span className={overdue ? 'font-medium text-tone-red' : ''}>
                {overdue ? 'Overdue since' : 'Due'} {issue.due_date}
              </span>
            )}
            {(issue.qa_rounds ?? 0) > 1 && (
              <span className="text-tone-amber" title="How often this went back to the partner for a re-check">
                QA round {issue.qa_rounds}
              </span>
            )}
            {(issue.comment_count ?? 0) > 0 && !open && <span>💬 {issue.comment_count}</span>}
            <span>Updated {relativeTime(issue.updated_at)}</span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <InlineSelect
            value={issue.status}
            options={statusOptions}
            tone={status.tone}
            disabled={statusOptions.length === 0}
            onChange={(next) => update({ status: next })}
          />
          {action && (
            <Button size="sm" variant="primary" onClick={() => update({ status: action.next })}>
              {action.label}
            </Button>
          )}
        </div>
      </div>

      {error && <p className="mx-4 mb-3 rounded-lg bg-tone-red-bg px-3 py-2 text-xs text-tone-red">{error}</p>}

      {open && (
        <div className="space-y-4 border-t border-line bg-raised/40 px-4 py-4">
          {issue.description && <p className="text-sm whitespace-pre-wrap text-ink-soft">{issue.description}</p>}

          {user?.role !== 'partner' && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-ink-faint">Assignee</span>
              <select
                className="field !w-auto !py-1 text-xs"
                value={issue.assignee_id ?? ''}
                onChange={(event) => update({ assignee_id: event.target.value ? Number(event.target.value) : null })}
              >
                <option value="">Unassigned</option>
                {users.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
                ))}
              </select>
              <span className="ml-2 text-ink-faint">Due</span>
              <input
                type="date"
                className="field !w-auto !py-1 text-xs"
                value={issue.due_date ?? ''}
                onChange={(event) => update({ due_date: event.target.value || null })}
              />
            </div>
          )}

          {loading && <p className="text-xs text-ink-faint">Loading conversation…</p>}

          {issueAttachments.length > 0 && <Gallery attachments={issueAttachments} onDeleted={reloadDetail} />}

          {detail && (
            <Thread
              issueId={issue.id}
              comments={detail.comments}
              attachments={detail.attachments}
              onPosted={(comment, uploaded) => {
                setDetail({
                  comments: [...detail.comments, comment],
                  attachments: [...detail.attachments, ...uploaded],
                });
                const merged = { ...issue, comment_count: (issue.comment_count ?? 0) + 1 };
                setIssue(merged);
                onChanged?.(merged);
              }}
              onDeleted={reloadDetail}
            />
          )}
        </div>
      )}
    </div>
  );

  function reloadDetail() {
    api
      .get<{ comments: Comment[]; attachments: Attachment[] }>(`/issues/${issue.id}`)
      .then((r) => setDetail({ comments: r.comments, attachments: r.attachments }));
  }
}

function Gallery({ attachments, onDeleted }: { attachments: Attachment[]; onDeleted: () => void }) {
  const { user } = useSession();
  const [zoom, setZoom] = useState<Attachment | null>(null);

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {attachments.map((attachment) => (
          <figure key={attachment.id} className="group relative">
            <button onClick={() => setZoom(attachment)} className="block">
              <img
                src={`/api/issues/attachments/${attachment.id}/raw`}
                alt={attachment.filename}
                loading="lazy"
                className="size-24 rounded-lg border border-line object-cover transition group-hover:brightness-95"
              />
            </button>
            {(user?.role === 'admin' || user?.name === attachment.uploader_name) && (
              <button
                onClick={async () => {
                  await api.del(`/issues/attachments/${attachment.id}`);
                  onDeleted();
                }}
                className="absolute -top-1.5 -right-1.5 hidden size-5 place-items-center rounded-full bg-tone-red text-xs text-white group-hover:grid"
                title="Delete image"
              >
                ✕
              </button>
            )}
            <figcaption className="mt-1 w-24 truncate text-[11px] text-ink-faint" title={attachment.filename}>
              {attachment.filename}
            </figcaption>
          </figure>
        ))}
      </div>

      {zoom && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-6" onClick={() => setZoom(null)}>
          <img src={`/api/issues/attachments/${zoom.id}/raw`} alt={zoom.filename} className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </>
  );
}

function Thread({
  issueId,
  comments,
  attachments,
  onPosted,
  onDeleted,
}: {
  issueId: number;
  comments: Comment[];
  attachments: Attachment[];
  onPosted: (comment: Comment, uploaded: Attachment[]) => void;
  onDeleted: () => void;
}) {
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!body.trim() && files.length === 0) return;
    setBusy(true);
    setError('');
    try {
      const { comment } = await api.post<{ comment: Comment }>(`/issues/${issueId}/comments`, {
        body: body.trim() || '(image only)',
      });
      const uploaded: Attachment[] = [];
      for (const file of files) {
        uploaded.push(await uploadImage(issueId, file, comment.id));
      }
      onPosted(comment, uploaded);
      setBody('');
      setFiles([]);
      if (fileInput.current) fileInput.current.value = '';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post the comment');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {comments.map((comment) => {
        const images = attachments.filter((a) => a.comment_id === comment.id);
        return (
          <article key={comment.id} className="rounded-lg border border-line bg-surface px-3 py-2">
            <header className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <span className="font-medium">{comment.author_name ?? 'Deleted user'}</span>
              {comment.author_role && (
                <Badge tone={comment.author_role === 'partner' ? 'purple' : 'slate'}>
                  {comment.author_role === 'partner' ? 'Partner' : comment.author_role === 'admin' ? 'Admin' : 'Dev'}
                </Badge>
              )}
              <Timestamp iso={comment.created_at} className="text-ink-faint" />
            </header>
            <p className="mt-1 text-sm whitespace-pre-wrap">{comment.body}</p>
            {images.length > 0 && (
              <div className="mt-2">
                <Gallery attachments={images} onDeleted={onDeleted} />
              </div>
            )}
          </article>
        );
      })}

      {comments.length === 0 && <p className="text-xs text-ink-faint">No comments yet.</p>}

      <form onSubmit={submit} className="space-y-2 rounded-lg border border-line bg-surface p-3">
        <textarea
          className="field min-h-20"
          placeholder="Add a comment — what you changed, what still fails, what you need…"
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
            multiple
            onChange={(event) => setFiles([...(event.target.files ?? [])])}
            className="text-xs text-ink-soft file:mr-2 file:rounded-lg file:border file:border-line-strong file:bg-raised file:px-2 file:py-1 file:text-xs"
          />
          {files.length > 0 && <span className="text-xs text-ink-faint">{files.length} image(s) attached</span>}
          <Button type="submit" size="sm" variant="primary" className="ml-auto" disabled={busy || (!body.trim() && files.length === 0)}>
            {busy ? 'Posting…' : 'Comment'}
          </Button>
        </div>
        {error && <p className="text-xs text-tone-red">{error}</p>}
      </form>
    </div>
  );
}

/** One request per image: the raw file is the body, the name rides in a header. */
export async function uploadImage(issueId: number, file: File, commentId?: number): Promise<Attachment> {
  const query = commentId ? `?comment_id=${commentId}` : '';
  const response = await fetch(`/api/issues/${issueId}/attachments${query}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name) },
    body: file,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Upload failed for ${file.name}`);
  return payload.attachment as Attachment;
}
